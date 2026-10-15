import { emit } from '@tauri-apps/api/event';
import { syncTrace } from '../../../shared/syncDiagnostics';
import { invoke } from '@tauri-apps/api/core';
import type { User } from '@supabase/supabase-js';
import { accountOwner, cache } from './cache';
export interface BrowserGrant {
  instance_id: string;
  login_request?: string;
  revision: number;
  config: { url: string; publishable_key: string };
  session: { access_token: string; expires_at: number; user: User };
}
let active: BrowserGrant | null = null;
export const grantIdentity = (grant: BrowserGrant) => JSON.stringify([grant.instance_id, grant.config.url, grant.session.user.id]);
export function currentBrowserGrant() { return active; }
export function acceptBrowserGrant(grant: BrowserGrant | null) {
  const changed = active?.login_request !== grant?.login_request || (active ? grantIdentity(active) : null) !== (grant ? grantIdentity(grant) : null);
  if (changed) syncTrace('lifecycle.account', { trigger: 'account-changed', source: 'companion/src/lib/browserAuth.ts:acceptBrowserGrant' });
  active = grant;
  if (changed && grant) syncTrace('lifecycle.account', { trigger: 'account-changed', source: 'companion/src/lib/browserAuth.ts:acceptBrowserGrant' });
  if (changed && typeof window !== 'undefined') void emit('diagnostic-account-changed').catch(() => {});
  if (grant) {
    const owner = accountOwner(grant.config.url, grant.session.user.id);
    cache.migrateScope(grantIdentity(grant), owner);
    cache.scope(owner);
  } else cache.scope('signed-out');
}
export const readBrowserGrant = () => invoke<BrowserGrant | null>('desktop_auth');
export async function browserAccessToken(identity: string) {
  const grant = await invoke<BrowserGrant | null>('desktop_cloud_auth');
  if (!grant || grantIdentity(grant) !== identity) throw new Error('账号已变化，请重新加载工作区');
  return grant.session.access_token;
}
export const beginBrowserLogin = () => invoke<void>('begin_browser_login');

export const confirmBrowserLogin = (grant: BrowserGrant, completed: boolean) => invoke<void>('confirm_browser_login', { instanceId: grant.instance_id, revision: grant.revision, request: grant.login_request, completed });
