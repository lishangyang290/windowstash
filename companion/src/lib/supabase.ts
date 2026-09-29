import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cache } from './cache';
import type { SupabaseConfig } from '../types';

export const CONNECTION_FAILED = '无法连接到 Supabase，请检查地址和 Key';
export const DATABASE_NOT_INITIALIZED = 'WindowStash 数据库尚未初始化，请查看开始使用.html';

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

export function getStoredSupabaseConfig(): SupabaseConfig | null {
  try {
    const config = cache.supabaseConfig();
    return config ? normalizeSupabaseConfig(config) : null;
  } catch {
    return null;
  }
}

export function resolveSupabaseConfig(): SupabaseConfig | null {
  return getStoredSupabaseConfig();
}

export const getSupabaseConfig = resolveSupabaseConfig;

function configKey(config: SupabaseConfig): string {
  return `${config.url}\n${config.publishableKey}`;
}

export async function testSupabaseConnection(value: SupabaseConfig): Promise<boolean> {
  try {
    const config = normalizeSupabaseConfig(value);
    const response = await fetch(new URL('/auth/v1/settings', `${config.url}/`), {
      headers: { apikey: config.publishableKey },
    });
    return response.ok;
  } catch {
    return false;
  }
}

function clearAuthStorage() {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith('sb-') && key.includes('-auth-token')) localStorage.removeItem(key);
  }
}

export async function saveSupabaseConfig(value: SupabaseConfig): Promise<SupabaseConfig> {
  const config = normalizeSupabaseConfig(value);
  if (!(await testSupabaseConnection(config))) throw new Error(CONNECTION_FAILED);
  const previous = getSupabaseConfig();
  if (!previous || configKey(previous) !== configKey(config)) {
    try {
      await client?.auth.signOut({ scope: 'local' });
    } finally {
      clearAuthStorage();
      client = null;
      clientConfig = '';
    }
  }
  cache.saveSupabaseConfig(config);
  return config;
}

export function getSupabaseClient(): SupabaseClient | null {
  const config = getSupabaseConfig();
  if (!config) {
    client = null;
    clientConfig = '';
    return null;
  }
  const key = configKey(config);
  if (client && clientConfig === key) return client;
  client = createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
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

export async function verifyWorkspaceSchema(client: SupabaseClient): Promise<void> {
  const { error } = await client.from('workspaces').select('id').limit(1);
  if (error) throw friendlySupabaseError(error);
}
