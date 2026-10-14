import { createClient } from '@supabase/supabase-js';
import { browser } from 'wxt/browser';
import { nativeAuth } from '@/lib/companion/auth';
import { getSupabaseConfig } from '@/lib/supabase/client';
import { requireDataAccount } from '@/lib/storage/accountScope';
import { nativeLibraryExchange, publishNativeWorkspaces } from '@/lib/companion/workspaces';
import { importNativeLibrary } from './nativeImport';
import { syncCloud } from '../../../shared/syncCloud';
import { synchronize, resolveSynchronizedConflict } from '../../../shared/workspaceSync';

/** Paired clients use the same native lease as Companion; standalone sync is unchanged. */
async function nativeContext(scope: string) {
  const exchange = await nativeLibraryExchange(scope); if (!exchange) return false;
  await requireDataAccount(scope);
  await publishNativeWorkspaces(scope);
  const config = await getSupabaseConfig(); if (!config) throw new Error('云端配置不可用');
  const client = createClient(config.url, config.publishableKey, {
    accessToken: async () => {
      await requireDataAccount(scope);
      const reply = await nativeAuth('read');
      const [, user] = JSON.parse(scope.slice('workspaces:'.length)) as [string, string];
      if (reply.config.url !== config.url || reply.session?.user.id !== user) throw new Error('账号已变化');
      return reply.session.access_token;
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, init) },
  });
  const [, user] = JSON.parse(scope.slice('workspaces:'.length)) as [string, string];
  return { exchange, cloud: syncCloud(client), user };
}
export async function syncNative(scope: string): Promise<boolean> {
  const context = await nativeContext(scope); if (!context) return false;
  await synchronize(context.exchange, context.cloud, context.user);
  await importNativeLibrary(scope, context.exchange);
  // Keep the existing durable alarm retry mechanism when Chrome is the surviving process.
  if (scope !== `workspaces:${(await browser.storage.local.get('windowstash-data-owner:v1'))['windowstash-data-owner:v1']}`) throw new Error('账号已变化');
  return true;
}
export async function resolveNativeConflict(scope: string, id: string, choice: 'local' | 'cloud'): Promise<boolean> {
  const context = await nativeContext(scope); if (!context) return false;
  await resolveSynchronizedConflict(context.exchange, context.cloud, context.user, id, choice);
  const exchange = context.exchange;
  await importNativeLibrary(scope, exchange);
  return true;
}
