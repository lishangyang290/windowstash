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
    lazyMock.remove.mockResolvedValue(undefined);
    lazyMock.removeByTabId.mockResolvedValue(undefined);
  });

  it('resolves the persistent lazy id after restart and navigates the same tab', async () => {
    browserMock.tabs.get.mockResolvedValue({ id: 42, url: 'chrome-extension://test/lazy-tab.html?id=lazy-1' });
    browserMock.tabs.update.mockResolvedValue({ id: 42 });
    lazyMock.get.mockResolvedValue({ id: 'lazy-1', originalUrl: 'https://real.example/page' });

    await resolveLazyTab(42);

    expect(browserMock.tabs.update).toHaveBeenCalledWith(42, { url: 'https://real.example/page' });
    expect(lazyMock.remove).toHaveBeenCalledWith('lazy-1');
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
