import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMock = vi.hoisted(() => ({
  runtime: { getURL: vi.fn((path: string) => `chrome-extension://test${path}`) },
  tabs: { get: vi.fn(), update: vi.fn(), reload: vi.fn() },
  windows: { getAll: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
  alarms: { create: vi.fn() },
}));
const lazyMock = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), put: vi.fn(), remove: vi.fn(), removeByTabId: vi.fn(), removeMany: vi.fn(),
  recordPresence: vi.fn(), removeConfirmedMissing: vi.fn(),
}));

vi.mock('wxt/browser', () => ({ browser: browserMock }));
vi.mock('@/lib/storage/lazyRestoreRepository', () => ({ lazyRestoreRepository: lazyMock }));

import {
  beginStartupLazyReconciliation,
  claimLazyTab,
  cleanupOrphanedLazyEntries,
  confirmLazyNavigation,
  finishStartupLazyReconciliation,
  handleLazyTabReady,
  hydrateStartupLazyTab,
  isStartupLazyReconciliationComplete,
  LazyTabResolutionError,
  lazyIdFromUrl,
  noteStartupLazyActivity,
  removeLazyTab,
  resolveLazyTab,
  resolveLogicalTab,
  resolveLogicalTabs,
  STARTUP_RECONCILIATION_GRACE_MS,
} from '@/features/workspaces/lazyRestore';
import { calculateTabDiff, getTabDomain } from '@/features/workspaces/tabDiff';
import type { StoredTab } from '@/types/workspace';

describe('lazyRestore', () => {
  let session: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    session = {};
    browserMock.storage.session.get.mockImplementation(async (key: string) => ({ [key]: session[key] }));
    browserMock.storage.session.set.mockImplementation(async (values: Record<string, unknown>) => { Object.assign(session, values); });
    browserMock.storage.session.remove.mockImplementation(async (key: string) => { delete session[key]; });
    browserMock.tabs.get.mockResolvedValue({ id: 42, windowId: 7, url: 'chrome-extension://test/lazy-tab.html?id=lazy-1' });
    browserMock.tabs.update.mockResolvedValue({ id: 42 });
    browserMock.tabs.reload.mockResolvedValue(undefined);
    lazyMock.put.mockResolvedValue(undefined);
    lazyMock.remove.mockResolvedValue(undefined);
    lazyMock.removeByTabId.mockResolvedValue(undefined);
    lazyMock.recordPresence.mockResolvedValue([]);
    lazyMock.removeConfirmedMissing.mockResolvedValue(undefined);
  });

  it('keeps the registry after tabs.update until the real URL is confirmed', async () => {
    browserMock.tabs.get.mockResolvedValue({ id: 42, url: 'chrome-extension://test/lazy-tab.html?id=lazy-1' });
    browserMock.tabs.update.mockResolvedValue({ id: 42 });
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page' });

    await resolveLazyTab(42);

    expect(browserMock.tabs.update).toHaveBeenCalledWith(42, { url: 'https://real.example/page' });
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
  });

  it('keeps an inactive placeholder lazy when its page becomes ready', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page', tabId: 900, windowId: 90 });

    await expect(handleLazyTabReady(42, 7, false, 'lazy-1')).resolves.toBe('waiting');

    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(lazyMock.put).toHaveBeenCalledWith(expect.objectContaining({ id: 'lazy-1', tabId: 42, windowId: 7 }));
  });

  it('automatically resolves an active placeholder when its page becomes ready', async () => {
    lazyMock.get.mockResolvedValue({
      id: 'lazy-1', originalUrl: 'https://real.example/page', tabId: 900, windowId: 90,
    });

    await expect(handleLazyTabReady(42, 7, true, 'lazy-1')).resolves.toBe('resolved');

    expect(lazyMock.put).toHaveBeenCalledWith(expect.objectContaining({ tabId: 42, windowId: 7 }));
    expect(browserMock.tabs.update).toHaveBeenCalledWith(42, { url: 'https://real.example/page' });
  });

  it('self-recovers when an already active placeholder reloads without onActivated', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-refresh', originalUrl: 'https://real.example/refreshed' });

    await expect(handleLazyTabReady(51, 8, true, 'lazy-refresh')).resolves.toBe('resolved');

    expect(browserMock.tabs.update).toHaveBeenCalledWith(51, { url: 'https://real.example/refreshed' });
  });

  it('retains the registry entry when navigation fails and permits a retry', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page' });
    browserMock.tabs.update.mockRejectedValueOnce(new Error('navigation failed')).mockResolvedValueOnce({ id: 42 });

    await expect(resolveLazyTab(42, 'lazy-1')).rejects.toThrow('navigation failed');
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
    await expect(resolveLazyTab(42, 'lazy-1')).resolves.toBe(true);
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
  });

  it('uses the original tab for a manual recovery request', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page' });

    await resolveLazyTab(73, 'lazy-1');

    expect(browserMock.tabs.update).toHaveBeenCalledWith(73, { url: 'https://real.example/page' });
  });

  it('reports a missing registry entry without navigating or retrying forever', async () => {
    lazyMock.get.mockResolvedValue(null);

    await expect(handleLazyTabReady(42, 7, true, 'missing')).resolves.toBe('missing');

    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
  });

  it('keeps fifty inactive placeholders from loading together', async () => {
    lazyMock.get.mockImplementation(async (id: string) => ({ id, originalUrl: `https://example.com/${id}`, tabId: 1000, windowId: 100 }));
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => handleLazyTabReady(index, 7, false, `lazy-${index}`)));

    expect(results.every((result) => result === 'waiting')).toBe(true);
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(lazyMock.put).toHaveBeenCalledTimes(50);
  });

  it('removes the registry only after onUpdated confirms a non-lazy committed URL', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page' });
    await claimLazyTab('lazy-1', 42, 7);
    await expect(confirmLazyNavigation(42, 'https://real.example/page')).resolves.toBe(true);
    expect(lazyMock.remove).toHaveBeenCalledWith('lazy-1');
  });

  it('does not remove an entry by a stale tab id without a current-session claim', async () => {
    await expect(confirmLazyNavigation(42, 'https://real.example/page')).resolves.toBe(false);
    expect(lazyMock.remove).not.toHaveBeenCalled();
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
  });

  it('keeps the registry when navigation is cancelled back to the placeholder', async () => {
    await expect(confirmLazyNavigation(42, 'chrome-extension://test/lazy-tab.html?id=lazy-1')).resolves.toBe(false);
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
  });

  it('survives three refresh retries before the real URL commits', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page', tabId: 42 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(handleLazyTabReady(42, 7, true, 'lazy-1')).resolves.toBe('resolved');
      await expect(confirmLazyNavigation(42, 'chrome-extension://test/lazy-tab.html?id=lazy-1')).resolves.toBe(false);
    }

    expect(browserMock.tabs.update).toHaveBeenCalledTimes(3);
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
    await confirmLazyNavigation(42, 'https://real.example/page');
    expect(lazyMock.remove).toHaveBeenCalledOnce();
  });

  it('shares one navigation when a lazy tab is activated repeatedly', async () => {
    let release!: () => void;
    browserMock.tabs.get.mockReturnValue(new Promise((resolve) => { release = () => resolve({ id: 42, url: 'chrome-extension://test/lazy-tab.html?id=lazy-1' }); }));
    browserMock.tabs.update.mockResolvedValue({ id: 42 });
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page' });

    const first = resolveLazyTab(42);
    const second = resolveLazyTab(42);
    release();
    await Promise.all([first, second]);

    expect(browserMock.tabs.update).toHaveBeenCalledOnce();
  });

  it('cleans the registry when the user closes a lazy tab', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page', tabId: 42 });
    await claimLazyTab('lazy-1', 42, 7);
    await removeLazyTab(42);
    expect(lazyMock.remove).toHaveBeenCalledWith('lazy-1');
  });

  it('rechecks repeatedly missing entries before removing them', async () => {
    lazyMock.recordPresence.mockResolvedValue(['orphan']);
    browserMock.windows.getAll.mockResolvedValue([{ tabs: [{ url: 'chrome-extension://test/lazy-tab.html?id=live' }] }]);

    await cleanupOrphanedLazyEntries(new Date('2026-01-02T00:00:00.000Z').getTime());

    expect(browserMock.windows.getAll).toHaveBeenCalledTimes(2);
    expect(lazyMock.removeConfirmedMissing).toHaveBeenCalledWith(
      ['orphan'],
      new Set(['live']),
      new Date('2026-01-02T00:00:00.000Z').getTime(),
      5 * 60 * 1000,
    );
  });

  it('keeps all existing entries while Chrome has not restored startup tabs yet', async () => {
    lazyMock.list.mockResolvedValue(Array.from({ length: 45 }, (_, index) => ({
      id: `lazy-${index}`,
      createdAt: '2025-01-01T00:00:00.000Z',
    })));

    await beginStartupLazyReconciliation(1_000);

    expect(lazyMock.list).not.toHaveBeenCalled();
    expect(lazyMock.recordPresence).not.toHaveBeenCalled();
    expect(browserMock.alarms.create).toHaveBeenCalledOnce();
  });

  it('rebinds a restored lazyId to its new tab and window ids without losing its URL', async () => {
    const entry = {
      id: 'lazy-a', originalUrl: 'https://real.example/a', createdAt: '2025-01-01T00:00:00.000Z',
      tabId: 11, windowId: 12,
    };
    lazyMock.get.mockResolvedValue(entry);

    await expect(claimLazyTab('lazy-a', 101, 202)).resolves.toEqual(expect.objectContaining({
      originalUrl: 'https://real.example/a', tabId: 101, windowId: 202,
    }));
    expect(lazyMock.put).toHaveBeenCalledWith({ ...entry, tabId: 101, windowId: 202 });
  });

  it('hydrates an inactive restored placeholder without loading its original URL', async () => {
    const entry = {
      id: 'lazy-visual', originalUrl: 'https://real.example/visual', title: 'Saved title',
      favIconUrl: 'https://real.example/favicon.ico', tabId: 11, windowId: 12,
    };
    lazyMock.get.mockResolvedValue(entry);
    await beginStartupLazyReconciliation(1_000);

    await expect(hydrateStartupLazyTab({
      id: 101, windowId: 202, url: 'chrome-extension://test/lazy-tab.html?id=lazy-visual', index: 0,
    })).resolves.toBe(true);

    expect(lazyMock.put).toHaveBeenCalledWith({ ...entry, tabId: 101, windowId: 202 });
    expect(browserMock.tabs.reload).toHaveBeenCalledWith(101);
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('marks absent entries after startup grace without deleting them', async () => {
    lazyMock.get.mockResolvedValue({ id: 'live', originalUrl: 'https://real.example/live', tabId: 1, windowId: 1 });
    browserMock.windows.getAll.mockResolvedValue([{ id: 88, tabs: [{
      id: 77, windowId: 88, url: 'chrome-extension://test/lazy-tab.html?id=live',
    }] }]);
    await beginStartupLazyReconciliation(1_000);

    await expect(finishStartupLazyReconciliation(1_000 + STARTUP_RECONCILIATION_GRACE_MS - 1)).resolves.toBe(false);
    expect(lazyMock.recordPresence).not.toHaveBeenCalled();

    await expect(finishStartupLazyReconciliation(1_000 + STARTUP_RECONCILIATION_GRACE_MS)).resolves.toBe(true);
    expect(lazyMock.put).toHaveBeenCalledWith(expect.objectContaining({ id: 'live', tabId: 77, windowId: 88 }));
    expect(lazyMock.recordPresence).toHaveBeenCalledWith(new Set(['live']), 1_000 + STARTUP_RECONCILIATION_GRACE_MS);
    expect(lazyMock.removeConfirmedMissing).not.toHaveBeenCalled();
    await expect(isStartupLazyReconciliationComplete()).resolves.toBe(true);
  });

  it('keeps an entry available when its window appears after startup reconciliation', async () => {
    browserMock.windows.getAll.mockResolvedValue([]);
    await beginStartupLazyReconciliation(1_000);
    await finishStartupLazyReconciliation(1_000 + STARTUP_RECONCILIATION_GRACE_MS);
    lazyMock.get.mockResolvedValue({
      id: 'late', originalUrl: 'https://real.example/late', tabId: 1, windowId: 1,
    });

    await expect(hydrateStartupLazyTab({
      id: 77, windowId: 88, url: 'chrome-extension://test/lazy-tab.html?id=late', index: 0,
    })).resolves.toBe(false);

    expect(lazyMock.put).toHaveBeenCalledWith(expect.objectContaining({ id: 'late', tabId: 77, windowId: 88 }));
    expect(lazyMock.remove).not.toHaveBeenCalled();
    expect(lazyMock.removeMany).not.toHaveBeenCalled();
  });

  it('waits for restored tab activity to become quiet before final cleanup', async () => {
    browserMock.windows.getAll.mockResolvedValue([]);
    await beginStartupLazyReconciliation(1_000);
    await noteStartupLazyActivity(1_000 + STARTUP_RECONCILIATION_GRACE_MS);

    await expect(finishStartupLazyReconciliation(1_000 + STARTUP_RECONCILIATION_GRACE_MS)).resolves.toBe(false);

    expect(browserMock.windows.getAll).not.toHaveBeenCalled();
    expect(lazyMock.recordPresence).not.toHaveBeenCalled();
  });

  it('does not treat other internal pages as lazy tabs', () => {
    expect(lazyIdFromUrl('chrome-extension://test/options.html')).toBeNull();
  });

  it('produces no diff for one loaded tab and 49 logical lazy tabs', async () => {
    const saved = savedTabs(50);
    lazyMock.get.mockImplementation(async (id: string) => lazyEntry(Number(id.replace('lazy-', ''))));
    const current = [
      { id: 1, title: 'Tab 0', url: 'https://example.com/0', index: 0, pinned: true },
      ...Array.from({ length: 49 }, (_, offset) => ({
        id: offset + 2,
        title: 'WindowStash',
        url: `chrome-extension://test/lazy-tab.html?id=lazy-${offset + 1}`,
        index: offset + 1,
        pinned: offset === 0,
      })),
    ];

    const logical = await resolveLogicalTabs(current);

    expect(calculateTabDiff(saved, logical)).toEqual({ added: [], removed: [], updated: [] });
    expect(logical.every((tab) => !tab.url.includes('chrome-extension://'))).toBe(true);
  });

  it('reports only one removed page when 45 of 51 current tabs are lazy', async () => {
    const saved = savedTabs(52);
    lazyMock.get.mockImplementation(async (id: string) => lazyEntry(Number(id.replace('lazy-', ''))));
    const current = [
      ...Array.from({ length: 45 }, (_, index) => ({
        id: index + 1,
        url: `chrome-extension://test/lazy-tab.html?id=lazy-${index}`,
        index,
      })),
      ...Array.from({ length: 6 }, (_, offset) => {
        const index = offset + 45;
        return { id: index + 1, title: `Tab ${index}`, url: `https://example.com/${index}`, index };
      }),
    ];

    const diff = calculateTabDiff(saved, await resolveLogicalTabs(current));

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toEqual([{ kind: 'removed', ...saved[51]! }]);
  });

  it('uses the original title, favicon and domain while retaining the existing tab id', async () => {
    lazyMock.get.mockResolvedValue(lazyEntry(7));

    const logical = await resolveLogicalTab({
      id: 77,
      title: 'WindowStash',
      url: 'chrome-extension://test/lazy-tab.html?id=lazy-7',
      favIconUrl: 'chrome-extension://test/icon-16.png',
      index: 7,
      pinned: false,
    });

    expect(logical).toEqual(expect.objectContaining({
      id: 77,
      title: 'Tab 7',
      url: 'https://example.com/7',
      favIconUrl: 'https://example.com/favicon-7.ico',
    }));
    expect(getTabDomain(logical.url)).toBe('example.com');
  });

  it('rejects a placeholder whose persistent registry entry is missing', async () => {
    lazyMock.get.mockResolvedValue(null);

    await expect(resolveLogicalTab({
      id: 77,
      url: 'chrome-extension://test/lazy-tab.html?id=missing',
      index: 0,
    })).rejects.toBeInstanceOf(LazyTabResolutionError);
  });

  it('preserves duplicate URL multiset counts across loaded and lazy tabs', async () => {
    const saved = [
      storedTab(0, 'https://same.example'),
      storedTab(1, 'https://same.example'),
      storedTab(2, 'https://other.example'),
    ];
    lazyMock.get.mockResolvedValue({ ...lazyEntry(1), originalUrl: 'https://same.example', title: 'Tab 1' });
    const logical = await resolveLogicalTabs([
      { id: 1, title: 'Tab 0', url: 'https://same.example', index: 0 },
      { id: 2, url: 'chrome-extension://test/lazy-tab.html?id=lazy-1', index: 1 },
    ]);

    const diff = calculateTabDiff(saved, logical);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toEqual([{ kind: 'removed', ...saved[2]! }]);
  });
});

function storedTab(position: number, url = `https://example.com/${position}`): StoredTab {
  return {
    title: `Tab ${position}`,
    url,
    favIconUrl: `https://example.com/favicon-${position}.ico`,
    position,
    pinned: position < 2,
  };
}

function savedTabs(count: number): StoredTab[] {
  return Array.from({ length: count }, (_, position) => storedTab(position));
}

function lazyEntry(position: number) {
  return {
    id: `lazy-${position}`,
    workspaceId: 'workspace-1',
    originalUrl: `https://example.com/${position}`,
    title: `Tab ${position}`,
    favIconUrl: `https://example.com/favicon-${position}.ico`,
    position,
    pinned: position < 2,
    createdAt: '2026-09-28T00:00:00.000Z',
  };
}
