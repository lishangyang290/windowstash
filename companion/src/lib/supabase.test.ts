import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  clients: [] as Array<{ auth: { signOut: ReturnType<typeof vi.fn> } }>,
  createClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

describe('Companion runtime Supabase config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.storage.clear();
    mocks.clients.length = 0;
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    Object.defineProperty(globalThis, 'localStorage', { value: {
      getItem: (key: string) => mocks.storage.get(key) ?? null,
      setItem: (key: string, value: string) => mocks.storage.set(key, value),
      removeItem: (key: string) => mocks.storage.delete(key),
      key: (index: number) => [...mocks.storage.keys()][index] ?? null,
      get length() { return mocks.storage.size; },
    }, configurable: true });
    mocks.createClient.mockImplementation(() => {
      const client = { auth: { signOut: vi.fn(async () => ({ error: null })) } };
      mocks.clients.push(client);
      return client;
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  });

  it('starts without stored configuration', async () => {
    const { getStoredSupabaseConfig, resolveSupabaseConfig } = await import('./supabase');
    expect(getStoredSupabaseConfig()).toBeNull();
    expect(resolveSupabaseConfig()).toBeNull();
  });

  it('uses development env only to prefill setup without persisting it', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://legacy.supabase.co/');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'legacy-key');
    mocks.storage.set('sb-legacy-auth-token', 'session');
    const { getDevelopmentSupabaseConfig, getStoredSupabaseConfig, resolveSupabaseConfig } = await import('./supabase');
    expect(getDevelopmentSupabaseConfig()).toEqual({ url: 'https://legacy.supabase.co', publishableKey: 'legacy-key' });
    expect(resolveSupabaseConfig()).toBeNull();
    expect(getStoredSupabaseConfig()).toBeNull();
    expect(mocks.storage.get('sb-legacy-auth-token')).toBe('session');
  });

  it('uses runtime config even when a development default exists', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://legacy.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'legacy-key');
    mocks.storage.set('windowstash-companion:supabase-config:v1', JSON.stringify({ url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' }));
    const { resolveSupabaseConfig } = await import('./supabase');
    expect(resolveSupabaseConfig()).toEqual({ url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' });
  });

  it('uses stored runtime config after a Companion restart', async () => {
    mocks.storage.set('windowstash-companion:supabase-config:v1', JSON.stringify({ url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' }));
    expect((await import('./supabase')).resolveSupabaseConfig()).toEqual({ url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' });
    vi.resetModules();
    expect((await import('./supabase')).resolveSupabaseConfig()).toEqual({ url: 'https://runtime.supabase.co', publishableKey: 'runtime-key' });
  });

  it('rejects service-role secrets', async () => {
    const { normalizeSupabaseConfig } = await import('./supabase');
    expect(() => normalizeSupabaseConfig({ url: 'https://project.supabase.co', publishableKey: 'sb_secret_never-use-this' })).toThrow('service_role');
  });

  it('persists tested configuration across module reloads', async () => {
    const { saveSupabaseConfig } = await import('./supabase');
    await saveSupabaseConfig({ url: 'https://one.supabase.co/', publishableKey: 'one' });
    vi.resetModules();
    const { getStoredSupabaseConfig } = await import('./supabase');
    expect(getStoredSupabaseConfig()).toEqual({ url: 'https://one.supabase.co', publishableKey: 'one' });
  });

  it('keeps saved configuration when startup is offline', async () => {
    const { saveSupabaseConfig } = await import('./supabase');
    await saveSupabaseConfig({ url: 'https://one.supabase.co', publishableKey: 'one' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await import('./supabase')).getStoredSupabaseConfig()).toEqual({ url: 'https://one.supabase.co', publishableKey: 'one' });
  });

  it('does not persist a failed connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const { getStoredSupabaseConfig, saveSupabaseConfig } = await import('./supabase');
    await expect(saveSupabaseConfig({ url: 'https://bad.supabase.co', publishableKey: 'bad' })).rejects.toThrow('无法连接');
    expect(getStoredSupabaseConfig()).toBeNull();
  });

  it('clears the old auth session, keeps local data, and creates a new client', async () => {
    mocks.storage.set('windowstash-companion:supabase-config:v1', JSON.stringify({ url: 'https://one.supabase.co', publishableKey: 'one' }));
    mocks.storage.set('sb-one-auth-token', 'session');
    mocks.storage.set('windowstash-companion:workspaces:v1', '[{"id":"local"}]');
    const { getSupabaseClient, saveSupabaseConfig } = await import('./supabase');
    const first = getSupabaseClient();
    await saveSupabaseConfig({ url: 'https://two.supabase.co', publishableKey: 'two' });
    const second = getSupabaseClient();
    expect(second).not.toBe(first);
    expect(mocks.clients[0]?.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.storage.has('sb-one-auth-token')).toBe(false);
    expect(mocks.storage.get('windowstash-companion:workspaces:v1')).toBe('[{"id":"local"}]');
  });
});
