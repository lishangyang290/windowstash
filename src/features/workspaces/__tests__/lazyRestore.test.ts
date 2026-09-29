import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMock = vi.hoisted(() => ({
  runtime: { getURL: vi.fn((path: string) => `chrome-extension://test${path}`) },
  tabs: { get: vi.fn(), update: vi.fn() },
  windows: { getAll: vi.fn() },
}));
const lazyMock = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), put: vi.fn(), remove: vi.fn(), removeByTabId: vi.fn(), removeMany: vi.fn(),
}));

vi.mock('wxt/browser', () => ({ browser: browserMock }));
vi.mock('@/lib/storage/lazyRestoreRepository', () => ({ lazyRestoreRepository: lazyMock }));

import {
  cleanupOrphanedLazyEntries,
  confirmLazyNavigation,
  handleLazyTabReady,
  LazyTabResolutionError,
  lazyIdFromUrl,
  removeLazyTab,
  resolveLazyTab,
  resolveLogicalTab,
  resolveLogicalTabs,
} from '@/features/workspaces/lazyRestore';
import { calculateTabDiff, getTabDomain } from '@/features/workspaces/tabDiff';
import type { StoredTab } from '@/types/workspace';

describe('lazyRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserMock.tabs.update.mockResolvedValue({ id: 42 });
    lazyMock.put.mockResolvedValue(undefined);
    lazyMock.remove.mockResolvedValue(undefined);
    lazyMock.removeByTabId.mockResolvedValue(undefined);
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
    await expect(handleLazyTabReady(42, false, 'lazy-1')).resolves.toBe('waiting');

    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(lazyMock.get).not.toHaveBeenCalled();
  });

  it('automatically resolves an active placeholder when its page becomes ready', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page' });

    await expect(handleLazyTabReady(42, true, 'lazy-1')).resolves.toBe('resolved');

    expect(browserMock.tabs.update).toHaveBeenCalledWith(42, { url: 'https://real.example/page' });
  });

  it('self-recovers when an already active placeholder reloads without onActivated', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-refresh', originalUrl: 'https://real.example/refreshed' });

    await expect(handleLazyTabReady(51, true, 'lazy-refresh')).resolves.toBe('resolved');

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

    await expect(handleLazyTabReady(42, true, 'missing')).resolves.toBe('missing');

    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
  });

  it('keeps fifty inactive placeholders from loading together', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => handleLazyTabReady(index, false, `lazy-${index}`)));

    expect(results.every((result) => result === 'waiting')).toBe(true);
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('removes the registry only after onUpdated confirms a non-lazy committed URL', async () => {
    await expect(confirmLazyNavigation(42, 'https://real.example/page')).resolves.toBe(true);
    expect(lazyMock.removeByTabId).toHaveBeenCalledWith(42);
  });

  it('keeps the registry when navigation is cancelled back to the placeholder', async () => {
    await expect(confirmLazyNavigation(42, 'chrome-extension://test/lazy-tab.html?id=lazy-1')).resolves.toBe(false);
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
  });

  it('survives three refresh retries before the real URL commits', async () => {
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page', tabId: 42 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(handleLazyTabReady(42, true, 'lazy-1')).resolves.toBe('resolved');
      await expect(confirmLazyNavigation(42, 'chrome-extension://test/lazy-tab.html?id=lazy-1')).resolves.toBe(false);
    }

    expect(browserMock.tabs.update).toHaveBeenCalledTimes(3);
    expect(lazyMock.removeByTabId).not.toHaveBeenCalled();
    await confirmLazyNavigation(42, 'https://real.example/page');
    expect(lazyMock.removeByTabId).toHaveBeenCalledOnce();
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
    await removeLazyTab(42);
    expect(lazyMock.removeByTabId).toHaveBeenCalledWith(42);
  });

  it('removes old registry entries that no longer have a placeholder tab', async () => {
    lazyMock.list.mockResolvedValue([
      { id: 'live', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'orphan', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    browserMock.windows.getAll.mockResolvedValue([{ tabs: [{ url: 'chrome-extension://test/lazy-tab.html?id=live' }] }]);

    await cleanupOrphanedLazyEntries(new Date('2026-01-02T00:00:00.000Z').getTime());

    expect(lazyMock.removeMany).toHaveBeenCalledWith(['orphan']);
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
