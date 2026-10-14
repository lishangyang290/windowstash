import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identities, ownerOf, SupabaseMemory } from '../../../tests/support/supabaseMemory';
import type { BrowserGrant } from '../lib/browserAuth';
const state = vi.hoisted(() => ({ grant: null as BrowserGrant | null, storage: new Map<string, string>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string) => command === 'local_workspaces' ? null : state.grant }));
import { acceptBrowserGrant } from '../lib/browserAuth';
import { cache } from '../lib/cache';
import { workspaceService } from './workspaces';
let server: SupabaseMemory;
function login(index: number) {
  const identity = identities[index]!;
  state.grant = { instance_id: 'simulated-profile', revision: index + 1, config: { url: identity.url, publishable_key: 'mock-publishable-key' }, session: { access_token: identity.token, expires_at: 9999999999, user: { id: identity.userId } } } as BrowserGrant;
  cache.saveSupabaseConfig({ url: identity.url, publishableKey: 'mock-publishable-key' });
  acceptBrowserGrant(state.grant);
}
beforeEach(() => {
  state.storage.clear(); state.grant = null;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => state.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { state.storage.set(key, value); },
    key: (index: number) => [...state.storage.keys()][index] ?? null,
    get length() { return state.storage.size; },
  });
  acceptBrowserGrant(null);
  server = new SupabaseMemory(); vi.stubGlobal('fetch', server.fetch);
});
afterEach(() => { vi.useRealTimers(); acceptBrowserGrant(null); vi.unstubAllGlobals(); });
describe('Companion with real SDK and simulated project/account transport', () => {
  it('does not let a delayed older refresh replace newly synced workspaces', async () => {
    login(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const hold = first; first = false;
      const response = await server.fetch(input, init);
      if (hold) await gate;
      return response;
    });
    const older = workspaceService.refresh();
    const settled = older.catch(() => undefined);
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    const identity = identities[0];
    server.account(identity.url, identity.userId).set('new', { id: 'new', user_id: identity.userId, name: 'Newly synced', tabs: [], status: 'active', updated_at: '2026-10-13' });
    expect((await workspaceService.refresh())[0]?.id).toBe('new');
    release(); await settled;
    expect(workspaceService.cached()[0]?.id).toBe('new');
  });

  it('preserves offline cache and fetches new cloud records without opening the manager', async () => {
    login(0);
    cache.saveWorkspaces([{ id: 'cached', name: 'Offline cache', tabCount: 1, updatedAt: '2026-01-01' }]);
    server.offline = true;
    vi.useFakeTimers();
    const failed = expect(workspaceService.refresh()).rejects.toThrow();
    await vi.runAllTimersAsync();
    await failed;
    vi.useRealTimers();
    expect(workspaceService.cached()[0]?.id).toBe('cached');
    server.offline = false;
    const identity = identities[0];
    server.account(identity.url, identity.userId).set('new', { id: 'new', user_id: identity.userId, name: 'Newly synced', tabs: [], status: 'active', updated_at: '2026-10-13' });
    expect((await workspaceService.refresh())[0]?.id).toBe('new');
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
  });
  it('isolates visible cache and recent history through A1 → A2 → B1 → A1', async () => {
    for (const [index, name] of ['A1', 'A2', 'B1'].entries()) {
      const identity = identities[index]!;
      server.account(identity.url, identity.userId).set('shared-id', { id: 'shared-id', user_id: identity.userId, name, tabs: [], status: 'active', updated_at: '2026-01-01' });
      login(index);
      expect(workspaceService.cached()).toEqual([]);
      expect(cache.recents()).toEqual({});
      expect((await workspaceService.refresh())[0]?.name).toBe(name);
      cache.markOpened('shared-id');
      expect(cache.currentScope()).toBe(ownerOf(identity.url, identity.userId));
    }
    login(0);
    expect(workspaceService.cached()[0]?.name).toBe('A1');
    expect(cache.recents()['shared-id']).toBeTruthy();
    expect((await workspaceService.refresh())[0]?.name).toBe('A1');
    expect(server.requests.map((request) => request.owner)).toEqual([0, 1, 2, 0].map((index) => ownerOf(identities[index]!.url, identities[index]!.userId)));
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
  });
  it('rejects a delayed A1 refresh after the grant moves to B1 without writing either cache', async () => {
    login(0);
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    server.beforeRequest = () => gate;
    const pending = workspaceService.refresh();
    const rejection = expect(pending).rejects.toThrow('账号已变化');
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    login(2); cache.saveWorkspaces([{ id: 'shared-id', name: 'B1 offline cache', tabCount: 0, updatedAt: '2026-01-01' }]);
    complete(); await rejection;
    expect(workspaceService.cached()[0]?.name).toBe('B1 offline cache');
    login(0); expect(workspaceService.cached()).toEqual([]);
  });
  it('restores caches from the previous profile-scoped format for each known project/user', () => {
    for (const [index, name] of ['A1', 'A2', 'B1'].entries()) {
      const identity = identities[index]!;
      const oldOwner = JSON.stringify(['simulated-profile', identity.url, identity.userId]);
      state.storage.set(`windowstash-companion:workspaces:v1:${oldOwner}`, JSON.stringify([{ id: 'shared-id', name, tabCount: 0, updatedAt: '2026-01-01' }]));
      state.storage.set(`windowstash-companion:recent:v1:${oldOwner}`, JSON.stringify({ 'shared-id': '2026-01-01' }));
      login(index);
      expect(workspaceService.cached()[0]?.name).toBe(name);
      expect(cache.recents()['shared-id']).toBe('2026-01-01');
      expect(state.storage.has(`windowstash-companion:workspaces:v1:${oldOwner}`)).toBe(true);
    }
    login(0); expect(workspaceService.cached()[0]?.name).toBe('A1');
  });
  it('restores the persisted A1 cache after Companion modules restart', async () => {
    login(0); cache.saveWorkspaces([{ id: 'shared-id', name: 'A1 persisted offline cache', tabCount: 1, updatedAt: '2026-01-01' }]);
    cache.markOpened('shared-id'); login(2);
    vi.resetModules();
    const restartedAuth = await import('../lib/browserAuth');
    const restartedCache = (await import('../lib/cache')).cache;
    expect(restartedCache.workspaces()).toEqual([]);
    const identity = identities[0];
    state.grant = { ...state.grant!, config: { url: identity.url, publishable_key: 'mock-publishable-key' }, session: { access_token: identity.token, expires_at: 9999999999, user: { id: identity.userId } } } as BrowserGrant;
    restartedAuth.acceptBrowserGrant(state.grant);
    expect(restartedCache.workspaces()[0]?.name).toBe('A1 persisted offline cache');
    expect(restartedCache.recents()['shared-id']).toBeTruthy();
    expect(server.requests).toEqual([]);
  });

});
