import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const storage = new Map<string, unknown>();
  const clients: Array<{ auth: { signOut: ReturnType<typeof vi.fn> } }> = [];
  return { storage, clients, createClient: vi.fn(), native: vi.fn() };
});

vi.mock('wxt/browser', () => ({ browser: {
  runtime: { sendNativeMessage: mocks.native },
  storage: { local: {
    get: vi.fn(async (key: string | string[] | null) => {
      if (key === null) return Object.fromEntries(mocks.storage);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((item) => mocks.storage.has(item)).map((item) => [item, mocks.storage.get(item)]));
    }),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => mocks.storage.set(key, value)); }),
    remove: vi.fn(async (keys: string | string[]) => { (Array.isArray(keys) ? keys : [keys]).forEach((key) => mocks.storage.delete(key)); }),
  } },
  permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
} }));

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

describe('runtime Supabase client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.storage.clear();
    vi.stubGlobal('navigator', { locks: { request: (_name: string, task: () => Promise<unknown>) => task() } });
    mocks.clients.length = 0;
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    mocks.createClient.mockImplementation(() => {
      const client = { auth: { signOut: vi.fn(async () => ({ error: null })), stopAutoRefresh: vi.fn(async () => {}) } };
      mocks.clients.push(client);
      return client;
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  });

  function staleLink() {
    mocks.storage.set('supabaseConfig', { url: 'https://project.supabase.co', publishableKey: 'public-fixture' });
    mocks.storage.set('windowstash-companion:instance:v1', 'b'.repeat(64));
    mocks.storage.set('windowstash-companion:auth-link:v1', { capability: 'a'.repeat(64) });
    mocks.storage.set('windowstash-auth:sb-project-auth-token', 'stale-session-fixture');
    mocks.storage.set('workspaces:fixture-owner', { saved: { sync: { syncStatus: 'pending' }, content: { name: 'Preserved' } } });
    mocks.storage.set('deleteTombstones:fixture-owner', { deleted: { workspaceId: 'deleted' } });
    mocks.storage.set('windowstash-auth:sb-other-auth-token', 'other-project-fixture');
  }

  it('does not hold the browser auth lock during a linked cloud refresh and logs out locally without fetch', async () => {
    staleLink();
    const request = vi.fn((_name: string, task: () => Promise<unknown>) => task());
    vi.stubGlobal('navigator', { locks: { request } });
    mocks.native.mockResolvedValue({ capability: 'a'.repeat(64), config: { url: 'https://project.supabase.co' }, session: { user: { id: 'A' }, access_token: 'fixture' } });
    const { getSupabaseClient } = await import('../client');
    await getSupabaseClient();
    const options = mocks.createClient.mock.calls[0]![2];
    await options.global.fetch('https://project.supabase.co/auth/v1/token?grant_type=refresh_token');
    expect(request).not.toHaveBeenCalled();
    const response = await options.global.fetch('https://project.supabase.co/auth/v1/logout?scope=local');
    expect(response.status).toBe(204);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recovers a confirmed missing native grant without losing workspaces or another project session', async () => {
    staleLink();
    mocks.native.mockResolvedValue({ status: 'error', code: 'not_linked' });
    const saved = structuredClone(mocks.storage.get('workspaces:fixture-owner'));
    const deleted = structuredClone(mocks.storage.get('deleteTombstones:fixture-owner'));
    const { resetMissingCompanionLink, getSupabaseClient } = await import('../client');
    await getSupabaseClient();
    await resetMissingCompanionLink();
    expect(mocks.storage.has('windowstash-companion:auth-link:v1')).toBe(false);
    expect(mocks.storage.has('windowstash-auth:sb-project-auth-token')).toBe(false);
    expect(mocks.storage.get('windowstash-data-owner:v1')).toBe('signed-out');
    expect(mocks.storage.get('workspaces:fixture-owner')).toEqual(saved);
    expect(mocks.storage.get('deleteTombstones:fixture-owner')).toEqual(deleted);
    expect(mocks.storage.get('windowstash-auth:sb-other-auth-token')).toBe('other-project-fixture');
    await getSupabaseClient();
    expect(mocks.clients).toHaveLength(2);
  });

  it.each(['network_unavailable', 'unauthorized_instance', 'auth_store_corrupt'])('preserves all state when native recovery receives %s', async (code) => {
    staleLink(); mocks.native.mockResolvedValue({ status: 'error', code });
    const before = structuredClone(mocks.storage);
    const { resetMissingCompanionLink } = await import('../client');
    await expect(resetMissingCompanionLink()).rejects.toThrow();
    expect(mocks.storage).toEqual(before);
  });

  it('does not reset a link that has already been restored', async () => {
    staleLink(); mocks.native.mockResolvedValue({ capability: 'a'.repeat(64), session: null, config: { url: 'https://project.supabase.co' } });
    const before = structuredClone(mocks.storage);
    await expect((await import('../client')).resetMissingCompanionLink()).rejects.toThrow('已恢复');
    expect(mocks.storage).toEqual(before);
  });

  it('requires a valid http/https URL and a non-empty publishable key', async () => {
    const { normalizeSupabaseConfig } = await import('../client');
    expect(() => normalizeSupabaseConfig({ url: 'not-a-url', publishableKey: 'key' })).toThrow('http/https');
    expect(() => normalizeSupabaseConfig({ url: 'https://project.supabase.co', publishableKey: '' })).toThrow('Publishable Key');
    expect(() => normalizeSupabaseConfig({ url: 'https://project.supabase.co', publishableKey: 'sb_secret_never-use-this' })).toThrow('service_role');
  });

  it('returns no stored config on a first production-style install', async () => {
    const { getStoredSupabaseConfig, resolveSupabaseConfig } = await import('../client');
    await expect(getStoredSupabaseConfig()).resolves.toBeNull();
    await expect(resolveSupabaseConfig()).resolves.toBeNull();
  });

  it('uses development env only to prefill setup without persisting it', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://legacy.supabase.co/');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'legacy-key');
    mocks.storage.set('windowstash-auth:sb-legacy-auth-token', 'session');
    const { getDevelopmentSupabaseConfig, getStoredSupabaseConfig, resolveSupabaseConfig } = await import('../client');
    expect(getDevelopmentSupabaseConfig()).toEqual({ url: 'https://legacy.supabase.co', publishableKey: 'legacy-key' });
    await expect(resolveSupabaseConfig()).resolves.toBeNull();
    await expect(getStoredSupabaseConfig()).resolves.toBeNull();
    expect(mocks.storage.get('windowstash-auth:sb-legacy-auth-token')).toBe('session');
  });

  it('uses runtime config even when a development default exists', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://legacy.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'legacy-key');
    mocks.storage.set('supabaseConfig', { url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' });
    const { resolveSupabaseConfig } = await import('../client');
    await expect(resolveSupabaseConfig()).resolves.toEqual({ url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' });
  });

  it('uses stored runtime config after an extension restart', async () => {
    mocks.storage.set('supabaseConfig', { url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' });
    await expect((await import('../client')).resolveSupabaseConfig()).resolves.toEqual({ url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' });
    vi.resetModules();
    await expect((await import('../client')).resolveSupabaseConfig()).resolves.toEqual({ url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' });
  });

  it('tests the real endpoint before persisting local configuration', async () => {
    const { getStoredSupabaseConfig, saveSupabaseConfig } = await import('../client');
    await saveSupabaseConfig({ url: 'https://one.supabase.co/', publishableKey: 'publishable-one' });
    await expect(getStoredSupabaseConfig()).resolves.toEqual({ url: 'https://one.supabase.co', publishableKey: 'publishable-one' });
    expect(fetch).toHaveBeenCalledWith(new URL('https://one.supabase.co/auth/v1/settings'), expect.objectContaining({ headers: { apikey: 'publishable-one' } }));
  });

  it('does not save a configuration when the connection test fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const { getStoredSupabaseConfig, saveSupabaseConfig } = await import('../client');
    await expect(saveSupabaseConfig({ url: 'https://bad.supabase.co', publishableKey: 'bad-key' })).rejects.toThrow('无法连接');
    await expect(getStoredSupabaseConfig()).resolves.toBeNull();
  });

  it('clears only auth state and recreates the client when the project changes', async () => {
    mocks.storage.set('supabaseConfig', { url: 'https://one.supabase.co', publishableKey: 'one' });
    mocks.storage.set('windowstash-auth:sb-one-auth-token', 'session');
    mocks.storage.set('workspaces', [{ id: 'local' }]);
    mocks.storage.set('lazyRestoreEntries', [{ id: 'lazy' }]);
    const { getSupabaseClient, saveSupabaseConfig } = await import('../client');
    const first = await getSupabaseClient();
    await saveSupabaseConfig({ url: 'https://two.supabase.co', publishableKey: 'two' });
    const second = await getSupabaseClient();
    expect(second).not.toBe(first);
    expect(mocks.clients[0]?.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.storage.has('windowstash-auth:sb-one-auth-token')).toBe(false);
    expect(mocks.storage.get('workspaces')).toEqual([{ id: 'local' }]);
    expect(mocks.storage.get('lazyRestoreEntries')).toEqual([{ id: 'lazy' }]);
  });

  it('maps a missing workspaces table to the setup guidance', async () => {
    const { friendlySupabaseError } = await import('../client');
    expect(friendlySupabaseError({ code: '42P01', message: 'relation workspaces does not exist' })).toEqual(expect.objectContaining({ message: expect.stringContaining('开始使用.html') }));
  });
it('preserves pending workspaces through the actual project-save flow A → B → A', async () => {
  mocks.storage.clear();
  const { workspaceRepository } = await import('@/lib/storage/workspaceRepository');
  const { selectDataAccount } = await import('@/lib/storage/accountScope');
  const { saveSupabaseConfig } = await import('../client');
  const a = { url: 'https://one.supabase.co', publishableKey: 'one' };
  const b = { url: 'https://two.supabase.co', publishableKey: 'two' };
  const content = { id: 'same-id', name: 'A offline', tabs: [], status: 'active' as const, activeTabIndex: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  mocks.storage.set('supabaseConfig', a);
  mocks.storage.set('windowstash-auth:sb-one-auth-token', JSON.stringify({ user: { id: 'same-user' } }));
  await selectDataAccount(a.url, 'same-user');
  await workspaceRepository.saveContent(content);
  await saveSupabaseConfig(b);
  expect(await workspaceRepository.list()).toEqual([]);
  mocks.storage.set('windowstash-auth:sb-two-auth-token', JSON.stringify({ user: { id: 'same-user' } }));
  await selectDataAccount(b.url, 'same-user');
  expect(await workspaceRepository.list()).toEqual([]);
  await workspaceRepository.saveContent({ ...content, name: 'B offline' });
  await saveSupabaseConfig(a);
  expect(await workspaceRepository.list()).toEqual([]);
  mocks.storage.set('windowstash-auth:sb-one-auth-token', JSON.stringify({ user: { id: 'same-user' } }));
  await selectDataAccount(a.url, 'same-user');
  expect((await workspaceRepository.get(content.id))?.content.name).toBe('A offline');
  expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
});

});
