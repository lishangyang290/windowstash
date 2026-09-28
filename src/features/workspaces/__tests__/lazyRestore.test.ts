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

import { cleanupOrphanedLazyEntries, lazyIdFromUrl, removeLazyTab, resolveLazyTab } from '@/features/workspaces/lazyRestore';

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
});
