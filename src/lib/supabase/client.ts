import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { browser } from 'wxt/browser';

const SESSION_PREFIX = 'windowstash-auth:';

const extensionStorage = {
  async getItem(key: string): Promise<string | null> {
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

let client: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  client =
    url && key
      ? createClient(url, key, {
          auth: {
            storage: extensionStorage,
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
          },
        })
      : null;
  return client;
}
