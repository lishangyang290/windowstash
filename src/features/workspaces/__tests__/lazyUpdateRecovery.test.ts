import { beforeEach, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';

const state = vi.hoisted(() => ({
  local: {} as Record<string, unknown>, session: {} as Record<string, unknown>,
  windows: [] as Browser.windows.Window[], scope: '', nextId: 100,
}));
const browser = vi.hoisted(() => {
  const store = (area: 'local' | 'session') => ({
    get: async (keys: string | string[] | null) => Object.fromEntries(
      (keys === null ? Object.keys(state[area]) : Array.isArray(keys) ? keys : [keys])
        .map(key => [key, structuredClone(state[area][key])])),
    set: async (values: object) => { Object.assign(state[area], structuredClone(values)); },
    remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete state[area][key]; },
  });
  return {
    storage: { local: store('local'), session: store('session') },
    runtime: { getURL: (path: string) => `chrome-extension://fixture${path}` },
    alarms: { create: vi.fn() },
    windows: {
      getAll: vi.fn(async () => structuredClone(state.windows)),
      get: vi.fn(async (id: number) => structuredClone(state.windows.find(window => window.id === id)!)),
    },
    tabs: {
      reload: vi.fn(), update: vi.fn(),
      create: vi.fn(async (options: { windowId: number; url: string; index: number; pinned: boolean; active: boolean }) => {
        const window = state.windows.find(window => window.id === options.windowId)!;
        const tab = { ...options, id: state.nextId++ } as Browser.tabs.Tab;
        window.tabs!.splice(options.index, 0, tab);
        window.tabs!.forEach((item, index) => { item.index = index; });
        return tab;
      }),
    },
  };
});
vi.mock('wxt/browser', () => ({ browser }));
vi.mock('@/lib/storage/accountScope', () => ({ accountStorageKey: async (key: string) => `${key}${state.scope}` }));
vi.mock('@/lib/storage/workspaceRepository', () => ({ workspaceRepository: {
  list: async () => Object.values(state.local[`workspaces${state.scope}`] ?? {}), get: async () => null,
} }));
vi.mock('@/lib/storage/syncLogRepository', () => ({ syncLogRepository: { add: vi.fn(async () => {}) } }));

import { lazyRestoreRepository } from '@/lib/storage/lazyRestoreRepository';
import { windowAssociationRepository } from '@/lib/storage/windowAssociationRepository';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { captureWindowAssociation, recoverMissingLazyTabs, restorePersistentWindowAssociations } from '../windowAssociation';
import { beginStartupLazyReconciliation, cleanupOrphanedLazyEntries, confirmLazyNavigation, finishStartupLazyReconciliation, hasMissingLazyTabs, initializeStartupLazyReconciliation, lazyIdFromTab, lazyTabUrl, removeLazyTab, resolveLazyTab, resolveLogicalTabs } from '../lazyRestore';

beforeEach(async () => {
  vi.clearAllMocks();
  state.local = {}; state.session = {}; state.windows = []; state.scope = ''; state.nextId = 100;
  await beginStartupLazyReconciliation(0);
  await finishStartupLazyReconciliation(60_000);
});

async function fixture(id = 'saved', windowId = 20, duplicate = false) {
  const tabs = Array.from({ length: 10 }, (_, index) => ({
    id: windowId * 100 + index, windowId, index, active: index === 0, pinned: index < 3,
    url: `https://${id}.test/${duplicate && index > 2 ? 'repeat' : index}`,
    title: `Title ${index}`, favIconUrl: `https://${id}.test/icon.png`,
  } as Browser.tabs.Tab));
  for (let index = 2; index < tabs.length; index++) {
    const tab = tabs[index]!;
    const entry = { id: `${id}-${index}`, workspaceId: id, originalUrl: tab.url!, title: tab.title!, favIconUrl: tab.favIconUrl!, position: index, pinned: tab.pinned, tabId: tab.id, windowId, createdAt: '' };
    await lazyRestoreRepository.put(entry);
    tab.url = lazyTabUrl(entry.id, entry);
  }
  state.windows.push({ id: windowId, tabs } as Browser.windows.Window);
  state.local.workspaces = { ...state.local.workspaces as object, [id]: { content: { id } } };
  await bindingRepository.set(windowId, id);
  await captureWindowAssociation(windowId, id, tabs);
  return structuredClone(tabs);
}

it.each([20, 99])('recovers 2 real + 8 lazy tabs after session loss with window ID %i', async windowId => {
  const original = await fixture('saved', 20, true);
  state.session = {};
  state.windows[0]!.id = windowId;
  state.windows[0]!.tabs = original.slice(0, 2).map(tab => ({ ...tab, windowId, id: tab.id! + 5000 }));
  // Exact pre-fix failure: the 20% residual cannot pass the existing matcher.
  expect(await restorePersistentWindowAssociations()).toBe(0);
  await initializeStartupLazyReconciliation();
  expect(await hasMissingLazyTabs()).toBe(true);
  expect(await recoverMissingLazyTabs()).toBe(8);
  expect(await recoverMissingLazyTabs()).toBe(0);
  expect(browser.tabs.create).toHaveBeenCalledTimes(8);
  expect(browser.tabs.create.mock.calls.every(([options]) => options.active === false && options.url.startsWith('data:text/html;'))).toBe(true);
  expect(browser.tabs.update).not.toHaveBeenCalled();
  expect(state.session.lazyStartupReconciled).toBe(true);
  expect(await restorePersistentWindowAssociations()).toBe(1);
  expect(await bindingRepository.get(windowId)).toBe('saved');
  const logical = await resolveLogicalTabs(state.windows[0]!.tabs!);
  expect(logical.map(tab => [tab.url, tab.title, tab.pinned, tab.index])).toEqual(original.map((tab, index) => [index < 2 ? tab.url : `https://saved.test/${index > 2 ? 'repeat' : index}`, `Title ${index}`, index < 3, index]));
  const clicked = state.windows[0]!.tabs![8]!;
  await resolveLazyTab(clicked.id!, lazyIdFromTab(clicked)!, windowId);
  expect(browser.tabs.update).toHaveBeenCalledWith(clicked.id, { url: 'https://saved.test/repeat' });
  await confirmLazyNavigation(clicked.id!, 'about:blank');
  expect(await lazyRestoreRepository.get('saved-8')).not.toBeNull();
  await confirmLazyNavigation(clicked.id!, 'https://saved.test/repeat');
  expect(await lazyRestoreRepository.get('saved-8')).toBeNull();
});

it('keeps surviving placeholders lazy and maintains the full snapshot during startup', async () => {
  const original = await fixture();
  state.session = {};
  await initializeStartupLazyReconciliation();
  expect(browser.tabs.reload).not.toHaveBeenCalled();
  expect(await recoverMissingLazyTabs()).toBe(0);
  await captureWindowAssociation(20, 'saved', original);
  expect((await windowAssociationRepository.list())[0]!.windowSnapshot.tabs).toHaveLength(10);
  expect(browser.tabs.update).not.toHaveBeenCalled();
});

it.each(['extension-reload', 'chrome-restart'])('preserves the entire live window and binding on %s', async mode => {
  await fixture();
  if (mode === 'chrome-restart') {
    state.windows[0]!.id = 90;
    state.windows[0]!.tabs!.forEach(tab => { tab.windowId = 90; tab.id! += 5000; });
  }
  const before = structuredClone(state.windows);
  const savedWorkspace = structuredClone(state.local.workspaces);
  state.session = {};
  await initializeStartupLazyReconciliation();
  await restorePersistentWindowAssociations();
  expect(state.windows).toEqual(before);
  expect(state.local.workspaces).toEqual(savedWorkspace);
  expect(await bindingRepository.get(state.windows[0]!.id!)).toBe('saved');
  expect(browser.tabs.create).not.toHaveBeenCalled();
  expect(browser.tabs.update).not.toHaveBeenCalled();
  expect(browser.tabs.reload).not.toHaveBeenCalled();
  expect(state.session.lazyStartupReconciliation).toBeUndefined();
});

it('retains the user-closed layout on the next reload instead of filling the old snapshot', async () => {
  await fixture();
  const closed = state.windows[0]!.tabs!.splice(4, 1)[0]!;
  state.windows[0]!.tabs!.forEach((tab, index) => { tab.index = index; });
  await removeLazyTab(closed.id!);
  await captureWindowAssociation(20, 'saved', state.windows[0]!.tabs!);
  const before = structuredClone(state.windows);
  state.session = {};
  await initializeStartupLazyReconciliation();
  await restorePersistentWindowAssociations();
  expect(await bindingRepository.get(20)).toBe('saved');
  expect(state.windows).toEqual(before);
  expect(await lazyRestoreRepository.get(lazyIdFromTab(closed)!)).toBeNull();
  expect(browser.tabs.create).not.toHaveBeenCalled();
});

it('uses persistent lazy IDs to keep identical workspace URLs bound to the correct windows', async () => {
  await fixture('first', 20);
  await fixture('second', 30);
  const second = state.windows[1]!;
  for (const entry of await lazyRestoreRepository.list()) {
    if (entry.workspaceId === 'second') await lazyRestoreRepository.put({ ...entry, originalUrl: entry.originalUrl.replace('second.test', 'first.test') });
  }
  second.tabs!.slice(0, 2).forEach(tab => { tab.url = tab.url!.replace('second.test', 'first.test'); });
  await captureWindowAssociation(30, 'second', second.tabs!);
  state.session = {};
  await initializeStartupLazyReconciliation();
  expect(await restorePersistentWindowAssociations()).toBe(2);
  expect(await bindingRepository.get(20)).toBe('first');
  expect(await bindingRepository.get(30)).toBe('second');
  expect(browser.tabs.create).not.toHaveBeenCalled();
});

it('recovers two workspaces in separate windows without mixing URLs', async () => {
  await fixture('first', 20); await fixture('second', 30);
  state.session = {};
  state.windows.forEach(window => { window.tabs = window.tabs!.slice(0, 2); });
  await initializeStartupLazyReconciliation();
  expect(await recoverMissingLazyTabs()).toBe(16);
  expect(state.windows.map(window => window.tabs!.length)).toEqual([10, 10]);
  expect(await restorePersistentWindowAssociations()).toBe(2);
  expect(await bindingRepository.get(20)).toBe('first');
  expect(await bindingRepository.get(30)).toBe('second');
});

it.each(['duplicate-window', 'duplicate-workspace', 'missing-record', 'all-records-missing', 'unrelated', 'signed-out', 'suppressed'])('retains data and refuses unsafe recovery: %s', async condition => {
  const original = await fixture();
  state.session = {};
  state.windows[0]!.tabs = original.slice(0, 2);
  if (condition === 'duplicate-window') state.windows.push({ ...structuredClone(state.windows[0]!), id: 30 });
  if (condition === 'duplicate-workspace') {
    await windowAssociationRepository.upsert('other', { tabs: original.slice(0, 2).map((tab, position) => ({ url: tab.url!, position, pinned: tab.pinned })), activeTabIndex: 0 });
    (state.local.workspaces as Record<string, unknown>).other = { content: { id: 'other' } };
  }
  if (condition === 'missing-record') await lazyRestoreRepository.remove('saved-2');
  if (condition === 'all-records-missing') state.local.lazyRestoreEntries = {};
  if (condition === 'unrelated') state.windows[0]!.tabs![0]!.url = 'https://unrelated.test';
  if (condition === 'suppressed') await bindingRepository.suppress(20);
  if (condition === 'signed-out') state.scope = ':signed-out';
  const before = structuredClone(state.local);
  await initializeStartupLazyReconciliation();
  expect(await recoverMissingLazyTabs()).toBe(0);
  expect(browser.tabs.create).not.toHaveBeenCalled();
  expect(state.local).toEqual(before);
  expect(await bindingRepository.get(20)).toBeNull();
  if (condition === 'all-records-missing') expect(await hasMissingLazyTabs(undefined, 20, true)).toBe(true);
});

it('keeps unrelated new windows usable while an old workspace is closed', async () => {
  await fixture();
  state.windows = [{ id: 99, tabs: [{ id: 900, index: 0, url: 'https://unrelated.test', pinned: false } as Browser.tabs.Tab] } as Browser.windows.Window];
  expect(await hasMissingLazyTabs(undefined, 99, true)).toBe(false);
});

it('uses the last observed order and pinned state after lazy tabs are moved', async () => {
  await fixture();
  const tabs = state.windows[0]!.tabs!;
  const moved = tabs.splice(8, 1)[0]!;
  moved.pinned = true;
  tabs.splice(0, 0, moved);
  tabs.forEach((tab, index) => { tab.index = index; });
  await captureWindowAssociation(20, 'saved', tabs);
  const expected = await resolveLogicalTabs(structuredClone(tabs));
  state.session = {};
  state.windows[0]!.tabs = tabs.filter(tab => !lazyIdFromTab(tab)).map((tab, index) => ({ ...tab, index }));
  await initializeStartupLazyReconciliation();
  expect(await recoverMissingLazyTabs()).toBe(8);
  expect((await resolveLogicalTabs(state.windows[0]!.tabs!)).map(tab => [tab.url, tab.pinned])).toEqual(expected.map(tab => [tab.url, tab.pinned]));
});

it('never expires original URLs solely because placeholders remain absent', async () => {
  await fixture();
  state.windows = [];
  await cleanupOrphanedLazyEntries(1_000);
  await cleanupOrphanedLazyEntries(864_000_000);
  expect(await lazyRestoreRepository.list()).toHaveLength(8);
});

it('clears the legacy migration guard immediately and stays ready on worker wakeups', async () => {
  await beginStartupLazyReconciliation(Date.now() + 86400_000);
  await initializeStartupLazyReconciliation();
  expect(state.session.lazyStartupReconciliation).toBeUndefined();
  expect(state.session.lazyStartupReconciled).toBe(true);
  const before = structuredClone(state.session);
  await initializeStartupLazyReconciliation();
  expect(state.session).toEqual(before);
});

it('recovers the current legacy batch after two restores of the same workspace', async () => {
  const original = await fixture();
  const association = (await windowAssociationRepository.list())[0]!;
  await windowAssociationRepository.upsert('saved', {
    ...association.windowSnapshot,
    tabs: association.windowSnapshot.tabs.map(({ url, position, pinned }) => ({ url, position, pinned })),
  });
  for (const entry of await lazyRestoreRepository.list()) {
    await lazyRestoreRepository.put({ ...entry, id: `old-${entry.id}`, windowId: 10, tabId: entry.tabId! + 10_000 });
  }
  state.session = {};
  state.windows[0]!.tabs = original.slice(0, 2);
  expect(await lazyRestoreRepository.list()).toHaveLength(16);
  await initializeStartupLazyReconciliation();
  expect(await recoverMissingLazyTabs()).toBe(8);
  expect(state.windows[0]!.tabs).toHaveLength(10);
  expect(state.windows[0]!.tabs!.slice(2).map(lazyIdFromTab)).toEqual(original.slice(2).map(lazyIdFromTab));
  expect(await lazyRestoreRepository.list()).toHaveLength(16);
  expect(await restorePersistentWindowAssociations()).toBe(1);
  expect(await bindingRepository.get(20)).toBe('saved');
});

it('refuses ambiguous legacy batches when no current numeric window matches', async () => {
  const original = await fixture();
  const association = (await windowAssociationRepository.list())[0]!;
  await windowAssociationRepository.upsert('saved', {
    ...association.windowSnapshot,
    tabs: association.windowSnapshot.tabs.map(({ url, position, pinned }) => ({ url, position, pinned })),
  });
  for (const entry of await lazyRestoreRepository.list()) {
    await lazyRestoreRepository.put({ ...entry, id: `old-${entry.id}`, windowId: 10, tabId: entry.tabId! + 10_000 });
  }
  state.windows[0]!.id = 99;
  state.windows[0]!.tabs = original.slice(0, 2);
  state.session = {};
  expect(await recoverMissingLazyTabs()).toBe(0);
  expect(browser.tabs.create).not.toHaveBeenCalled();
});

it('persists complete restore identity even during the startup grace period', async () => {
  const original = await fixture();
  await beginStartupLazyReconciliation();
  await windowAssociationRepository.removeForWorkspace('saved');
  await captureWindowAssociation(20, 'saved', original, undefined, true);
  const saved = (await windowAssociationRepository.list())[0]!;
  expect(saved.windowSnapshot.tabs).toHaveLength(10);
  expect(saved.windowSnapshot.tabs.filter(tab => tab.lazyId)).toHaveLength(8);
});

it('reproduces the reported 15 to 6 loss with two retained batches of 9 entries', async () => {
  const positions = new Set([0, 2, 3, 4, 5, 6, 7, 8, 11]);
  const urls = Array.from({ length: 15 }, (_, index) => index === 1 ? 'chrome://extensions/'
    : [10, 13, 14].includes(index) ? 'chrome://newtab/'
    : index === 12 ? 'chrome-extension://previous-extension/options.html' : `https://fixture.test/${index}`);
  const tabs = urls.map((url, index) => ({ id: 2000 + index, windowId: 20, index, pinned: false, active: index === 1, url } as Browser.tabs.Tab));
  for (const position of positions) {
    const entry = { id: `current-${position}`, workspaceId: 'saved', originalUrl: urls[position]!, title: `Saved ${position}`, favIconUrl: 'https://fixture.test/icon.png', position, pinned: false, tabId: tabs[position]!.id, windowId: 20, createdAt: '' };
    await lazyRestoreRepository.put(entry);
    await lazyRestoreRepository.put({ ...entry, id: `previous-${position}`, windowId: 10, tabId: 3000 + position });
    tabs[position]!.url = lazyTabUrl(entry.id);
  }
  state.local.workspaces = { saved: { content: { id: 'saved', tabs: urls.map(url => ({ url })) } } };
  await windowAssociationRepository.upsert('saved', { tabs: urls.map((url, position) => ({ url, position, pinned: false })), activeTabIndex: 1 });
  state.windows = [{ id: 20, tabs: tabs.filter((_, index) => !positions.has(index)).map((tab, index) => ({ ...tab, index })) } as Browser.windows.Window];
  state.session = {};
  expect(state.windows[0]!.tabs).toHaveLength(6);
  await initializeStartupLazyReconciliation();
  expect(await recoverMissingLazyTabs()).toBe(9);
  expect(state.windows[0]!.tabs).toHaveLength(15);
  expect((await resolveLogicalTabs(state.windows[0]!.tabs!)).map(tab => tab.url)).toEqual(urls);
  expect(await restorePersistentWindowAssociations()).toBe(1);
  expect(await bindingRepository.get(20)).toBe('saved');
  expect(await lazyRestoreRepository.list()).toHaveLength(18);
  expect(browser.tabs.update).not.toHaveBeenCalled();
  await finishStartupLazyReconciliation(Date.now() + 61_000);
  await captureWindowAssociation(20, 'saved', state.windows[0]!.tabs!);
  expect((await windowAssociationRepository.list())[0]!.windowSnapshot.tabs.filter(tab => tab.lazyId)).toHaveLength(9);
  state.session = {};
  state.windows[0]!.tabs = state.windows[0]!.tabs!.filter(tab => !lazyIdFromTab(tab)).map((tab, index) => ({ ...tab, index }));
  await initializeStartupLazyReconciliation();
  expect(await recoverMissingLazyTabs()).toBe(9);
  expect((await resolveLogicalTabs(state.windows[0]!.tabs!)).map(tab => tab.url)).toEqual(urls);
  expect(await restorePersistentWindowAssociations()).toBe(1);
  expect(await bindingRepository.get(20)).toBe('saved');
});
