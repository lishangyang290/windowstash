import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ local: new Map<string, unknown>(), session: new Map<string, unknown>(), current: { id: 7, focused: true, alwaysOnTop: false, incognito: false, tabs: [] as Array<{ id: number; index: number; url: string; pinned: boolean; active: boolean }> }, nativeReply: {} as object }));
const events = vi.hoisted(() => ({ addListener: vi.fn(), removeListener: vi.fn() }));
const storageArea = (values: Map<string, unknown>) => ({
  get: vi.fn(async (keys: string | string[] | null) => structuredClone(Object.fromEntries((keys === null ? [...values.keys()] : Array.isArray(keys) ? keys : [keys]).filter((key) => values.has(key)).map((key) => [key, values.get(key)])))),
  set: vi.fn(async (items: Record<string, unknown>) => { Object.entries(items).forEach(([key, value]) => values.set(key, structuredClone(value))); }),
  remove: vi.fn(async (keys: string | string[]) => { (Array.isArray(keys) ? keys : [keys]).forEach((key) => values.delete(key)); }),
});
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: storageArea(fixture.local), session: storageArea(fixture.session), onChanged: events },
  runtime: { sendNativeMessage: vi.fn(async () => structuredClone(fixture.nativeReply)), sendMessage: vi.fn(async () => undefined), getURL: (path: string) => `chrome-extension://fixture${path}` },
  windows: { getCurrent: vi.fn(async () => structuredClone(fixture.current)), getAll: vi.fn(async () => []) },
} }));

const config = { url: 'https://benchmark.supabase.co', publishableKey: 'public-fixture-key' };
const userId = 'fixture-user';
const scope = `workspaces:${JSON.stringify([config.url, userId])}`;
let stopRefresh: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.local.clear(); fixture.session.clear();
  fixture.local.set('supabaseConfig', config);
  fixture.local.set('windowstash-data-owner:v1', JSON.stringify([config.url, userId]));
  fixture.local.set('windowstash-data-revision:v1', 'fixture-revision');
  fixture.local.set('windowstash-data-migrated:v1', JSON.stringify([config.url, userId]));
  fixture.local.set('windowstash-account-metadata:v2', JSON.stringify([config.url, userId]));
  fixture.local.set('windowstash-companion:auth-link:v1', { capability: 'a'.repeat(64) });
  fixture.local.set('windowstash-companion:instance:v1', 'b'.repeat(64));
  fixture.nativeReply = { capability: 'a'.repeat(64), config: { url: config.url, publishable_key: config.publishableKey }, session: { access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: { id: userId } } };
  fixture.session.set(scope.replace(/^workspaces/, 'windowBinding:7'), 'fixture-workspace');
  fixture.local.set(scope, { 'fixture-workspace': { accountStorageKey: scope, content: { id: 'fixture-workspace', name: 'Private fixture', status: 'active', tabs: [], activeTabIndex: 0, createdAt: '2026-10-13', updatedAt: '2026-10-13' }, sync: { syncStatus: 'synced' } } });
  vi.stubGlobal('navigator', { locks: { request: (_name: string, task: () => Promise<unknown>) => task() } });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
});
afterEach(async () => { await stopRefresh?.(); stopRefresh = undefined; vi.unstubAllGlobals(); });

it.each([0, 50])('profiles cold SDK startup with %i lazy tabs using cloned in-memory Chrome/Native fixtures', async (lazyCount) => {
  const { browser } = await import('wxt/browser');
  const { authService } = await import('@/lib/supabase/authService');
  const { getSupabaseClient } = await import('@/lib/supabase/client');
  const { startPopupPerformance, measurePopupStage, popupPerformanceSnapshot } = await import('@/lib/popupPerformance');
  const { loadPopupWindow, readPopupWindow } = await import('./startup');
  const lazyKey = scope.replace(/^workspaces/, 'lazyRestoreEntries');
  fixture.local.set(lazyKey, Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`lazy-${index}`, { id: `lazy-${index}`, originalUrl: `https://example.invalid/${index}`, title: 'Fixture', favIconUrl: 'https://example.invalid/icon.png' }])));
  fixture.current.tabs = Array.from({ length: lazyCount || 10 }, (_, index) => ({ id: index + 1, index, url: lazyCount ? `chrome-extension://fixture/lazy-tab.html?id=lazy-${index}` : `https://example.invalid/${index}`, active: index === 0, pinned: index === 1 }));
  startPopupPerformance();
  const started = performance.now();
  const current = readPopupWindow();
  const session = await measurePopupStage('identity', () => authService.session());
  expect(session?.user.id).toBe(userId);
  const snapshot = await loadPopupWindow(scope, await current);
  expect(snapshot.logicalTabsReady).toBe(true);
  expect(snapshot.resolution.status).toBe('resolved');
  expect(snapshot.tabs[1]?.pinned).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.mocked(browser.runtime.sendNativeMessage).mock.calls.length).toBe(4);
  const metrics = popupPerformanceSnapshot();
  const stages = Object.fromEntries([...new Set(metrics.samples.map((sample) => sample.stage))].map((stage) => [stage, { count: metrics.samples.filter((sample) => sample.stage === stage).length, totalMs: Number(metrics.samples.filter((sample) => sample.stage === stage).reduce((sum, sample) => sum + sample.durationMs, 0).toFixed(3)) }]));
  const lazyReads = vi.mocked(browser.storage.local.get).mock.calls.filter(([keys]) => keys === lazyKey).length;
  expect(lazyReads).toBe(lazyCount ? 1 : 0);
  expect(vi.mocked(browser.storage.local.get).mock.calls.length).toBeLessThanOrEqual(lazyCount ? 22 : 21);
  console.log(JSON.stringify({ condition: 'Node / real Supabase SDK / mocked Chrome and Native IPC / no injected delay / one cold sample', lazyCount, totalMs: Number((performance.now() - started).toFixed(3)), localReads: vi.mocked(browser.storage.local.get).mock.calls.length, lazyReads, nativeMessages: vi.mocked(browser.runtime.sendNativeMessage).mock.calls.length, stages }));
  stopRefresh = () => getSupabaseClient().then((client) => client?.auth.stopAutoRefresh());
});

it('rejects prepared private data when Native identity changes during the scoped lazy read', async () => {
  const { authService } = await import('@/lib/supabase/authService');
  const { getSupabaseClient } = await import('@/lib/supabase/client');
  const { lazyRestoreRepository } = await import('@/lib/storage/lazyRestoreRepository');
  const { loadPopupWindow, readPopupWindow } = await import('./startup');
  const lazyKey = scope.replace(/^workspaces/, 'lazyRestoreEntries');
  fixture.local.set(lazyKey, { private: { id: 'private', originalUrl: 'https://private.invalid', title: 'Private' } });
  fixture.current.tabs = [{ id: 1, index: 0, url: 'chrome-extension://fixture/lazy-tab.html?id=private', active: true, pinned: false }];
  await authService.session();
  stopRefresh = () => getSupabaseClient().then((client) => client?.auth.stopAutoRefresh());
  const list = lazyRestoreRepository.list;
  vi.spyOn(lazyRestoreRepository, 'list').mockImplementationOnce(async (key) => {
    const entries = await list(key);
    fixture.nativeReply = { ...fixture.nativeReply, session: { user: { id: 'other-user' } } };
    return entries;
  });
  await expect(loadPopupWindow(scope, await readPopupWindow())).rejects.toThrow('账号已变化');
});
