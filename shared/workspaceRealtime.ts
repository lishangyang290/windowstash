// Structural transport types support the separately installed extension/Companion SDKs.
interface Change { table: string; eventType: string; new: Record<string, unknown> }
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
  hint: (payload: Change) => void,
  ready: () => void,
) {
  let active = true;
  const changed: typeof hint = payload => { if (active) hint(payload); };
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
    // Also covers server-side replication recovery without a new channel join.
    if (payload.extension === 'postgres_changes' && payload.status === 'ok') calibrated();
  });
  channel.subscribe(status => { if (status === 'SUBSCRIBED') calibrated(); });
  return () => {
    active = false;
    return client.removeChannel(channel).catch(() => 'error' as const);
  };
}
