import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { acceptBrowserGrant, beginBrowserLogin, browserAccessToken, grantIdentity, type BrowserGrant } from './browserAuth';
import { cache } from './cache';
const grant = { instance_id: 'instance-A', revision: 1, config: { url: 'https://project1', publishable_key: 'fixture-key' }, session: { access_token: 'fixture-access', expires_at: 9999999999, user: { id: 'user-A' } } } as BrowserGrant;
beforeEach(() => {
  invoke.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => { acceptBrowserGrant(null); cache.scope(''); vi.unstubAllGlobals(); });
describe('browser-authorized desktop access', () => {
  it('only supplies an access token for the exact active profile/project/account', async () => {
    invoke.mockResolvedValueOnce(grant);
    expect(await browserAccessToken(grantIdentity(grant))).toBe('fixture-access');
    invoke.mockResolvedValueOnce({ ...grant, session: { ...grant.session, user: { id: 'user-B' } } });
    await expect(browserAccessToken(grantIdentity(grant))).rejects.toThrow('账号已变化');
  });
  it('isolates cached workspaces across accounts without removing the previous cache', () => {
    acceptBrowserGrant(grant);
    cache.saveWorkspaces([{ id: 'A', name: 'A', tabCount: 1, updatedAt: '2026-01-01' }]);
    acceptBrowserGrant({ ...grant, session: { ...grant.session, user: { ...grant.session.user, id: 'user-B' } } });
    expect(cache.workspaces()).toEqual([]);
    acceptBrowserGrant(grant);
    expect(cache.workspaces()[0]?.id).toBe('A');
  });
  it('starts login without asking for credentials or sending them as command parameters', async () => {
    invoke.mockResolvedValue(undefined);
    await beginBrowserLogin();
    expect(invoke).toHaveBeenCalledWith('begin_browser_login');
  });
});

it('keeps the same project/user cache when choosing another Chrome profile', () => {
  acceptBrowserGrant(grant);
  cache.saveWorkspaces([{ id: 'A', name: 'A', tabCount: 1, updatedAt: '2026-01-01' }]);
  acceptBrowserGrant({ ...grant, instance_id: 'another-profile' });
  expect(cache.workspaces()[0]?.id).toBe('A');
});
