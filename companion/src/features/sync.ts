import { invoke } from '@tauri-apps/api/core';
import { currentBrowserGrant, grantIdentity } from '../lib/browserAuth';
import { getSupabaseClient } from '../lib/supabase';
import { RealtimeSync } from '../../../shared/realtimeSync';
import { syncCloud } from '../../../shared/syncCloud';
import { synchronize } from '../../../shared/workspaceSync';
import { subscribeWorkspaceChanges } from '../../../shared/workspaceRealtime';

export function startWorkspaceSync(): RealtimeSync | null {
  const grant = currentBrowserGrant(), client = getSupabaseClient();
  if (!grant || !client) return null;
  const identity = grantIdentity(grant), login = grant.login_request;
  const exchange = (action: string, payload: Record<string, unknown>) => {
    const active = currentBrowserGrant();
    if (!active || grantIdentity(active) !== identity || active.login_request !== login) throw new Error('账号已变化，同步已停止');
    return invoke('workspace_sync', { instance: grant.instance_id, project: grant.config.url, user: grant.session.user.id, action, payload });
  };
  const controller = new RealtimeSync((hint, ready) =>
    subscribeWorkspaceChanges(client, grant.session.user.id, hint, ready),
  () => synchronize(exchange, syncCloud(client), grant.session.user.id));
  controller.start();
  return controller;
}
