import type { TraceContext } from './diagnostics';
import { traceContext } from './syncDiagnostics';
import { syncTrace } from './syncDiagnostics';
// Structural transport types support the separately installed extension/Companion SDKs.
interface Change { table: string; eventType: string; new: Record<string, unknown>; commit_timestamp?: string }
interface Channel {
  on(type: 'postgres_changes', filter: { event: 'INSERT' | 'UPDATE'; schema: string; table: string; filter: string }, callback: (payload: Change) => void): unknown;
  on(type: 'system', filter: Record<string, never>, callback: (payload: { extension: string; status: string }) => void): unknown;
  subscribe(callback: (status: string) => void): unknown;
}

/** Register changes before joining; calibrate only after database readiness, also on recovery. */
export function subscribeWorkspaceChanges<T extends Channel>(
  client: {
    channel(name: string, options: { config: { postgres_changes_options: { wait: boolean; timeout: number } } }): T;
    removeChannel(channel: T): Promise<unknown>;
  },
  user: string,
  hint: (payload: Change, trace?: TraceContext) => void,
  ready: () => void,
) {
  let active = true;
  const subscription = syncTrace('realtime.start', { trace: traceContext('startup') });
  const changed: typeof hint = payload => {
    if (!active) return;
    const id = payload.new.id ?? payload.new.workspace_id;
    const trace = syncTrace('realtime.event', { trace: { ...traceContext('realtime'), parentEventId: subscription.parentEventId }, deleted: payload.table === 'workspace_tombstones' ? 1 : 0,
      workspace: typeof id === 'string' ? id : undefined, serverAt: typeof (payload.new.updated_at ?? payload.new.deleted_at) === 'string' ? String(payload.new.updated_at ?? payload.new.deleted_at) : undefined });
    hint(payload, trace);
  };
  const calibrated = () => { if (active) ready(); };
  const filter = `user_id=eq.${user}`;
  // A rapid stop/start must not reuse an SDK channel still awaiting unsubscribe.
  const channel = client.channel(`windowstash-sync:${user}:${crypto.randomUUID()}`, {
    config: { postgres_changes_options: { wait: true, timeout: 20_000 } },
  });
  channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'workspaces', filter }, changed);
  channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'workspaces', filter }, changed);
  channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'workspace_tombstones', filter }, changed);
  channel.on('system', {}, payload => {
    if (active && payload.extension === 'postgres_changes') syncTrace('realtime.database', { trace: subscription, status: payload.status === 'ok' ? 'ok' : 'error' });
    // Also covers server-side replication recovery without a new channel join.
    if (payload.extension === 'postgres_changes' && payload.status === 'ok') calibrated();
  });
  channel.subscribe(status => {
    if (!active) return;
    syncTrace('realtime.status', { trace: subscription, result: status === 'SUBSCRIBED' ? 'success' : 'observed', status: status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED' ? status : 'other' });
    if (status === 'SUBSCRIBED') calibrated();
  });
  return () => {
    active = false;
    syncTrace('realtime.stop', { trace: subscription });
    return client.removeChannel(channel).catch(() => 'error' as const);
  };
}
