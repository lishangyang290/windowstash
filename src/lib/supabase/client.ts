import { hideDataAccount, selectDataAccount } from '@/lib/storage/accountScope';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';
import { authLink, authLock, nativeAuth } from '@/lib/companion/auth';
import { measurePopupStage } from '@/lib/popupPerformance';

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export const DATABASE_NOT_INITIALIZED = 'WindowStash 数据库尚未初始化，请查看开始使用.html';
export const CONNECTION_FAILED = '无法连接到 Supabase，请检查地址和 Key';

const SESSION_PREFIX = 'windowstash-auth:';

const extensionStorage = {
  async getItem(key: string): Promise<string | null> {
    if (key.endsWith('-auth-token') && await authLink()) {
      const reply = await nativeAuth('read');
      const projectKey = `sb-${new URL(reply.config.url).hostname.split('.')[0]}-auth-token`;
      return key === projectKey && reply.session ? JSON.stringify(reply.session) : null;
    }
    const result = await browser.storage.local.get(`${SESSION_PREFIX}${key}`);
    return (result[`${SESSION_PREFIX}${key}`] as string | undefined) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await browser.storage.local.set({ [`${SESSION_PREFIX}${key}`]: value });
  },
  async removeItem(key: string): Promise<void> {
    await browser.storage.local.remove(`${SESSION_PREFIX}${key}`);
  },
};

let client: SupabaseClient | null = null;
let clientConfig = '';

function isServiceRoleKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  try {
    const payload = key.split('.')[1];
    if (!payload) return false;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))).role === 'service_role';
  } catch {
    return false;
  }
}

export function normalizeSupabaseConfig(value: SupabaseConfig): SupabaseConfig {
  const url = value.url.trim().replace(/\/+$/, '');
  const publishableKey = value.publishableKey.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('请输入有效的 http/https Project URL');
  }
  if (!url || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('请输入有效的 http/https Project URL');
  if (!publishableKey) throw new Error('请输入 Publishable Key');
  if (isServiceRoleKey(publishableKey)) throw new Error('请使用 Publishable Key，不要使用 service_role key');
  return { url, publishableKey };
}

export function getDevelopmentSupabaseConfig(): SupabaseConfig | null {
  if (!import.meta.env.DEV) return null;
  try {
    return normalizeSupabaseConfig({
      url: import.meta.env.VITE_SUPABASE_URL ?? '',
      publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
    });
  } catch {
    return null;
  }
}

export async function getStoredSupabaseConfig(): Promise<SupabaseConfig | null> {
  const result = await measurePopupStage('config-storage', () => browser.storage.local.get(STORAGE_KEYS.supabaseConfig));
  try {
    return result[STORAGE_KEYS.supabaseConfig]
      ? normalizeSupabaseConfig(result[STORAGE_KEYS.supabaseConfig] as SupabaseConfig)
      : null;
  } catch {
    return null;
  }
}

export async function resolveSupabaseConfig(): Promise<SupabaseConfig | null> {
  return getStoredSupabaseConfig();
}

export const getSupabaseConfig = resolveSupabaseConfig;

function configKey(config: SupabaseConfig): string {
  return `${config.url}\n${config.publishableKey}`;
}

async function ensureHostPermission(config: SupabaseConfig): Promise<boolean> {
  const origins = [`${new URL(config.url).origin}/*`];
  return browser.permissions.request({ origins });
}

export async function testSupabaseConnection(value: SupabaseConfig): Promise<boolean> {
  let config: SupabaseConfig;
  try {
    config = normalizeSupabaseConfig(value);
    if (!(await ensureHostPermission(config))) return false;
    const response = await fetch(new URL('/auth/v1/settings', `${config.url}/`), {
      headers: { apikey: config.publishableKey },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function clearAuthStorage(): Promise<void> {
  const values = await browser.storage.local.get(null);
  const keys = Object.keys(values).filter((key) => key.startsWith(SESSION_PREFIX));
  if (keys.length) await browser.storage.local.remove(keys);
}

export async function saveSupabaseConfig(value: SupabaseConfig, verifiedConfig?: SupabaseConfig): Promise<SupabaseConfig> {
  const config = normalizeSupabaseConfig(value);
  if ((!verifiedConfig || configKey(normalizeSupabaseConfig(verifiedConfig)) !== configKey(config))
    && !(await testSupabaseConnection(config))) throw new Error(CONNECTION_FAILED);
  const previous = await getSupabaseConfig();
  if (!previous || configKey(previous) !== configKey(config)) {
    // Bind legacy pending data to the previous account before changing projects.
    if (previous) {
      const key = `windowstash-auth:sb-${new URL(previous.url).hostname.split('.')[0]}-auth-token`;
      const stored = await authLink() ? await nativeAuth('read').then((reply) => reply.config.url === previous.url && reply.session ? JSON.stringify(reply.session) : null) : (await browser.storage.local.get(key))[key];
      let userId: string | undefined;
      try { userId = typeof stored === 'string' ? JSON.parse(stored).user?.id as string | undefined : undefined; } catch { /* No usable legacy session. */ }
      if (userId) await selectDataAccount(previous.url, userId, true);
    }
    await hideDataAccount();
    if (await authLink()) await nativeAuth('clear');
    try {
      await client?.auth.signOut({ scope: 'local' });
    } finally {
      await clearAuthStorage();
      client = null;
      clientConfig = '';
    }
  }
  await browser.storage.local.set({ [STORAGE_KEYS.supabaseConfig]: config });
  return config;
}

export async function getSupabaseClient(knownConfig?: SupabaseConfig | null): Promise<SupabaseClient | null> {
  const config = knownConfig === undefined ? await getSupabaseConfig() : knownConfig;
  if (!config) {
    client = null;
    clientConfig = '';
    return null;
  }
  const key = configKey(config);
  if (client && clientConfig === key) return client;
  client = createClient(config.url, config.publishableKey, {
    auth: {
      storage: extensionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        return authLock(async () => {
          if (!(await authLink())) {
            const response = await fetch(input, init);
            if (response.ok) {
              const session = await response.clone().json();
              const key = `windowstash-auth:sb-${new URL(config.url).hostname.split('.')[0]}-auth-token`;
              await browser.storage.local.set({ [key]: JSON.stringify(session) });
            }
            return response;
          }
          const reply = await nativeAuth('refresh');
          if (!reply.session) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: '请在 Chrome 中重新登录' }), { status: 401 });
          return new Response(JSON.stringify(reply.session), { headers: { 'Content-Type': 'application/json' } });
        });
      }
      return fetch(input, init);
    }) as typeof fetch },
  });
  clientConfig = key;
  return client;
}

export function isSchemaMissingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; message?: string };
  return ['42P01', 'PGRST205'].includes(value.code ?? '')
    || /(?:relation|table).*workspaces.*(?:does not exist|schema cache)/i.test(value.message ?? '');
}

export function friendlySupabaseError(error: unknown): unknown {
  return isSchemaMissingError(error) ? new Error(DATABASE_NOT_INITIALIZED) : error;
}
