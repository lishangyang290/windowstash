import { beforeEach, expect, it, vi } from 'vitest';
import type { LazyRestoreEntry } from '@/lib/storage/lazyRestoreRepository';

const state = vi.hoisted(() => ({ local: {} as Record<string, unknown>, session: {} as Record<string, unknown> }));
const browser = vi.hoisted(() => {
  const store = (area: 'local' | 'session') => ({
    get: async (keys: string | string[] | null) => Object.fromEntries(
      (keys === null ? Object.keys(state[area]) : Array.isArray(keys) ? keys : [keys])
        .map((key) => [key, structuredClone(state[area][key])]),
    ),
    set: async (values: Record<string, unknown>) => { Object.assign(state[area], structuredClone(values)); },
    remove: async (key: string) => { delete state[area][key]; },
  });
  return {
    runtime: { getURL: (path: string) => `chrome-extension://fixture${path}` },
    storage: { local: store('local'), session: store('session') },
    tabs: { reload: vi.fn(), update: vi.fn(), get: vi.fn() },
    windows: { getAll: vi.fn() },
    alarms: { create: vi.fn() },
  };
});
vi.mock('wxt/browser', () => ({ browser }));
vi.mock('@/lib/companion/auth', () => ({ authLink: async () => null }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.local = {
    supabaseConfig: { url: 'https://project-a.supabase.test', publishableKey: 'fixture' },
    'windowstash-auth:sb-project-a-auth-token': JSON.stringify({ user: { id: 'user-1' } }),
  };
  state.session = {};
  browser.tabs.get.mockResolvedValue({ id: 101, windowId: 20, url: 'chrome-extension://fixture/lazy-tab.html?id=saved' });
});

it.each([false, true])('restores inactive placeholders after reload with legacy data = %s', async (legacy) => {
  const entries: LazyRestoreEntry[] = Array.from({ length: 50 }, (_, index) => ({
    id: `lazy-${index}`, workspaceId: 'workspace-1', title: `Saved ${index}`,
    originalUrl: `https://example.test/${index}`, favIconUrl: 'https://example.test/favicon.ico',
    position: index, pinned: false, createdAt: '2026-10-01T00:00:00.000Z',
    tabId: index + 1, windowId: 1,
  }));
  if (legacy) state.local.lazyRestoreEntries = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
  else {
    const { lazyRestoreRepository } = await import('@/lib/storage/lazyRestoreRepository');
    for (const entry of entries) await lazyRestoreRepository.put(entry);
  }
  // Recreate extension modules and session storage while retaining durable local data.
  vi.resetModules();
  state.session = {};
  const lazy = await import('@/features/workspaces/lazyRestore');
  const { lazyRestoreRepository } = await import('@/lib/storage/lazyRestoreRepository');
  const tabs = entries.map((entry, index) => ({
    id: index + 101, windowId: 20, index, active: false,
    pendingUrl: lazy.lazyTabUrl(entry.id), url: 'about:blank',
  }));
  browser.windows.getAll.mockResolvedValue([{ id: 20, tabs }]);
  await lazy.beginStartupLazyReconciliation(1_000);
  await lazy.hydrateStartupLazyTabs();
  expect(browser.tabs.reload).toHaveBeenCalledTimes(50);
  expect(browser.tabs.update).not.toHaveBeenCalled();
  await lazy.finishStartupLazyReconciliation(61_000);
  await lazy.cleanupOrphanedLazyEntries(361_000);
  expect(await lazyRestoreRepository.list()).toHaveLength(50);
  await expect(lazy.handleLazyTabReady(101, 20, true, 'lazy-0')).resolves.toBe('resolved');
  expect(browser.tabs.update).toHaveBeenCalledExactlyOnceWith(101, { url: entries[0]!.originalUrl });
  // A successful update alone must not discard the durable recovery record.
  expect(await lazyRestoreRepository.get('lazy-0')).not.toBeNull();
  await lazy.confirmLazyNavigation(101, entries[0]!.originalUrl);
  expect(await lazyRestoreRepository.get('lazy-0')).toBeNull();
  expect(await lazyRestoreRepository.list()).toHaveLength(49);
  if (legacy) expect(Object.keys(state.local.lazyRestoreEntries as object)).toHaveLength(50);
});

it('preserves recovery records through logout, account switching, and original-account login', async () => {
  const { lazyRestoreRepository } = await import('@/lib/storage/lazyRestoreRepository');
  const { hideDataAccount, selectDataAccount } = await import('@/lib/storage/accountScope');
  const lazy = await import('@/features/workspaces/lazyRestore');
  await lazyRestoreRepository.put({
    id: 'saved', workspaceId: 'workspace-1', title: 'Saved',
    originalUrl: 'https://example.test/saved', favIconUrl: 'https://example.test/favicon.ico',
    position: 0, pinned: false, createdAt: '2026-10-01T00:00:00.000Z',
  });
  const original = structuredClone(state.local);
  await hideDataAccount();
  expect(await lazyRestoreRepository.get('saved')).toBeNull();
  await expect(lazy.handleLazyTabReady(101, 20, true, 'saved')).resolves.toBe('missing');
  browser.windows.getAll.mockResolvedValue([{ id: 20, tabs: [{ id: 101, windowId: 20, url: lazy.lazyTabUrl('saved'), active: false }] }]);
  await lazy.beginStartupLazyReconciliation();
  await lazy.hydrateStartupLazyTabs();
  expect(browser.tabs.reload).not.toHaveBeenCalled();
  expect(browser.tabs.update).not.toHaveBeenCalled();
  state.local['windowstash-auth:sb-project-a-auth-token'] = JSON.stringify({ user: { id: 'user-2' } });
  await selectDataAccount('https://project-a.supabase.test', 'user-2');
  expect(await lazyRestoreRepository.get('saved')).toBeNull();
  expect(await lazyRestoreRepository.get('never-existed')).toBeNull();
  await expect(lazy.handleLazyTabReady(101, 20, true, 'saved')).resolves.toBe('missing');
  expect(browser.tabs.update).not.toHaveBeenCalled();
  state.local['windowstash-auth:sb-project-a-auth-token'] = JSON.stringify({ user: { id: 'user-1' } });
  await selectDataAccount('https://project-a.supabase.test', 'user-1');
  expect(await lazyRestoreRepository.get('saved')).toEqual(expect.objectContaining({ originalUrl: 'https://example.test/saved' }));
  for (const [key, value] of Object.entries(original)) {
    if (key.startsWith('lazyRestoreEntries')) expect(state.local[key]).toEqual(value);
  }
  await expect(lazy.handleLazyTabReady(101, 20, true, 'saved')).resolves.toBe('resolved');
  expect(await lazyRestoreRepository.get('saved')).not.toBeNull();
});
