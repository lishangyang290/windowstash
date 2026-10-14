import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserGrant } from '../lib/browserAuth';
import type { LocalWorkspaces } from '../lib/localWorkspaces';
const fixture = vi.hoisted(() => ({ read: vi.fn(), storage: new Map<string, string>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.read }));
import { acceptBrowserGrant } from '../lib/browserAuth';
import { cache } from '../lib/cache';
import { workspaceService } from './workspaces';
function login(userId = 'A') {
  acceptBrowserGrant({ instance_id: 'profile', revision: 1, config: { url: 'https://fixture.supabase.co', publishable_key: 'fixture' }, session: { user: { id: userId }, access_token: 'fixture', expires_at: 0 } } as BrowserGrant);
}
function local(userId = 'A', name = 'Local'): LocalWorkspaces {
  return { instance_id: 'profile', project_url: 'https://fixture.supabase.co', user_id: userId, revision: 1, items: [{ id: userId, name, tabCount: 2, updatedAt: '2026-10-14' }] };
}
beforeEach(() => {
  fixture.storage.clear(); fixture.read.mockReset();
  vi.stubGlobal('localStorage', { getItem: (key: string) => fixture.storage.get(key) ?? null, setItem: (key: string, value: string) => fixture.storage.set(key, value) });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network must not be used'); }));
  login(); fixture.read.mockResolvedValue(local());
});
afterEach(() => { acceptBrowserGrant(null); vi.unstubAllGlobals(); });
describe('Companion local workspace source', () => {
  it('reads native data while offline without a fresh cloud token', async () => {
    expect((await workspaceService.refresh())[0]?.name).toBe('Local');
    expect(fixture.read).toHaveBeenCalledWith('local_workspaces');
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.workspaces()[0]?.name).toBe('Local');
  });
  it('uses an explicitly empty native list after deletion without resurrecting old cloud cache', async () => {
    cache.saveWorkspaces(local().items);
    fixture.read.mockResolvedValue({ ...local(), revision: 2, items: [] });
    expect(await workspaceService.refresh()).toEqual([]);
    expect(cache.workspaces()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the cache when native storage cannot be read', async () => {
    cache.saveWorkspaces(local().items); fixture.read.mockRejectedValue(new Error('Disk unavailable'));
    await expect(workspaceService.refresh()).rejects.toThrow('Disk unavailable');
    expect(cache.workspaces()[0]?.name).toBe('Local');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects delayed data after an account switch', async () => {
    let release!: (value: LocalWorkspaces) => void;
    fixture.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = workspaceService.refresh();
    const failed = expect(pending).rejects.toThrow('已变化');
    login('B'); cache.saveWorkspaces(local('B', 'B private').items);
    release(local('A')); await failed;
    expect(cache.workspaces()[0]?.name).toBe('B private');
  });
  it('prevents a delayed older native refresh from replacing a newer one', async () => {
    let release!: (value: LocalWorkspaces) => void;
    fixture.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = workspaceService.refresh();
    const failed = expect(pending).rejects.toThrow('已变化');
    fixture.read.mockResolvedValue(local('A', 'New'));
    await workspaceService.refresh(); release(local('A', 'Old')); await failed;
    expect(cache.workspaces()[0]?.name).toBe('New');
  });
});
