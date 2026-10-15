import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceHash, type NativeLibrary } from '../../../shared/workspaceSync';
const f = vi.hoisted(() => ({ grant: { instance_id: 'instance-A', login_request: 'login-A', config: { url: 'https://fixture.test' }, session: { user: { id: 'user-A' } } } as { instance_id: string; login_request: string; config: { url: string }; session: { user: { id: string } } } | null,
  invoke: vi.fn(), rpc: vi.fn(), channel: vi.fn(), remove: vi.fn(), filters: [] as unknown[], ready: null as ((status: string) => void) | null, hint: null as (() => void) | null,
  system: null as ((payload: { extension: string; status: string }) => void) | null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: f.invoke }));
vi.mock('../lib/browserAuth', () => ({ currentBrowserGrant: () => f.grant, grantIdentity: (grant: NonNullable<typeof f.grant>) => JSON.stringify([grant.instance_id, grant.config.url, grant.session.user.id]) }));
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc: f.rpc, channel: f.channel, removeChannel: f.remove }) }));
import { startWorkspaceSync } from './sync';
const id = '11111111-1111-4111-8111-111111111111', stamp = '2026-10-14T00:00:00Z';
let state: NativeLibrary;
beforeEach(() => {
  vi.clearAllMocks(); f.filters = []; f.hint = null; f.ready = null; f.system = null;
  f.remove.mockResolvedValue('ok');
  f.grant = { instance_id: 'instance-A', login_request: 'login-A', config: { url: 'https://fixture.test' }, session: { user: { id: 'user-A' } } };
  state = { generation: 0, revision: 1, digest: 'fixture', records: {}, deleted: [], remote_deleted: {}, delete_ack: [], conflicts: {} };
  const channel = { on: vi.fn((event, filter, hint) => {
    if (event === 'system') f.system = hint;
    else { f.filters.push(filter); f.hint = () => hint({ table: filter.table, eventType: filter.event, new: {} }); }
    return channel;
  }), subscribe: vi.fn(ready => { f.ready = ready; return channel; }) };
  f.channel.mockReturnValue(channel);
  let lease = '', parts = '';
  f.invoke.mockImplementation(async (_command, request) => {
    expect(request.instance).toBe('instance-A'); expect(request.project).toBe('https://fixture.test'); expect(request.user).toBe('user-A');
    const { action, payload } = request;
    if (action === 'acquire') { if (lease) return { status: 'busy' }; lease = 'a'.repeat(64); return { status: 'acquired', token: lease }; }
    if (action === 'read') return { status: 'read', generation: state.generation, chunks: 1, index: 0, part: Buffer.from(JSON.stringify(state)).toString('hex') };
    if (payload.token !== lease) throw new Error('wrong lease');
    if (action === 'renew') return { status: 'renewed' };
    if (action === 'release') { lease = ''; return { status: 'released' }; }
    if (payload.generation !== state.generation) throw new Error('stale_workspace_revision');
    if (payload.index === 0) parts = '';
    parts += payload.part;
    if (payload.index + 1 < payload.chunks) return { status: 'staged' };
    state = JSON.parse(Buffer.from(parts, 'hex').toString('utf8')); state.generation++; return { status: 'persisted' };
  });
});
describe('Companion independent cloud synchronization (mock RPC/native transport)', () => {
  it('receives a complete workspace while Chrome is absent, using one scoped event subscription', async () => {
    const content = { id, name: 'Remote', status: 'active' as const, tabs: [{ title: 'Remote tab', url: 'https://example.test/remote', position: 0, pinned: true }], activeTabIndex: 0, createdAt: stamp, updatedAt: stamp };
    const row = { id, name: content.name, status: content.status, tabs: content.tabs, active_tab_index: 0, created_at: stamp, updated_at: stamp, content_hash: await workspaceHash(content), user_id: 'user-A' };
    f.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: { protocol: 1, user_id: 'user-A', records: [row], deleted: [] }, error: null }) }));
    const sync = startWorkspaceSync()!;
    await vi.waitFor(() => expect(state.records[id]?.content.tabs).toEqual(content.tabs));
    expect(f.channel).toHaveBeenCalledOnce(); expect(f.filters).toHaveLength(3);
    expect(f.channel).toHaveBeenCalledWith(expect.stringMatching(/^windowstash-sync:user-A:/), {
      config: { postgres_changes_options: { wait: true, timeout: 20_000 } },
    });
    expect(f.filters).toContainEqual({ event: 'INSERT', schema: 'public', table: 'workspace_tombstones', filter: 'user_id=eq.user-A' });
    sync.stop(); expect(f.remove).toHaveBeenCalledOnce();
  });
  it('calibrates changes missed before database readiness and after replication recovery or wake', async () => {
    let deleted = false;
    const content = { id, name: 'Created in subscription gap', status: 'active' as const, tabs: [], activeTabIndex: 0, createdAt: stamp, updatedAt: stamp };
    const row = { ...content, active_tab_index: 0, created_at: stamp, updated_at: stamp, content_hash: await workspaceHash(content), user_id: 'user-A' };
    let records: unknown[] = [];
    f.rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: null, data: {
      protocol: 1, user_id: 'user-A', records,
      deleted: deleted ? [{ workspace_id: id, user_id: 'user-A', deleted_at: stamp }] : [],
    } }) }));
    const sync = startWorkspaceSync()!;
    await vi.waitFor(() => expect(f.invoke.mock.calls.some(([, request]) => request.action === 'release')).toBe(true));
    expect(state.records[id]).toBeUndefined();
    // Startup snapshot completed, but the replication subscription was not yet active.
    // Simulate an older server's early channel join; a later database-ready signal
    // must still cause a new snapshot, even when no row event was received.
    f.ready!('SUBSCRIBED');
    await vi.waitFor(() => expect(f.rpc.mock.calls).toHaveLength(2));
    records = [row]; f.system!({ extension: 'postgres_changes', status: 'ok' });
    await vi.waitFor(() => expect(state.records[id]?.content.name).toBe(content.name));
    // Channel stays joined while server replication recovers; no row hint was delivered.
    records = []; deleted = true;
    f.system!({ extension: 'postgres_changes', status: 'ok' });
    await vi.waitFor(() => expect(state.remote_deleted[id]).toBe(stamp));
    expect(state.records[id]).toBeUndefined();
    // Existing online/resume handling requests a snapshot even before reconnect finishes.
    sync.kick();
    await vi.waitFor(() => expect(f.rpc.mock.calls.length).toBeGreaterThanOrEqual(5));
    sync.stop();
    const calls = f.rpc.mock.calls.length;
    f.ready!('SUBSCRIBED'); f.system!({ extension: 'postgres_changes', status: 'ok' }); f.hint!();
    await Promise.resolve(); expect(f.rpc.mock.calls).toHaveLength(calls);
  });
  it('uploads a durable pending record without calling any Chrome API', async () => {
    const content = { id, name: 'Pending after Chrome exit', status: 'active' as const, tabs: [], activeTabIndex: 0, createdAt: stamp, updatedAt: stamp };
    state.records[id] = { content, sync: { syncStatus: 'pending', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: stamp, lastSyncError: null } };
    const hash = await workspaceHash(content);
    f.rpc.mockImplementation((name: string, args) => ({ abortSignal: async () => ({ error: null, data: name === 'windowstash_snapshot_v1'
      ? { protocol: 1, user_id: 'user-A', records: [], deleted: [] }
      : { ...args.workspace, user_id: 'user-A', updated_at: stamp, content_hash: hash } }) }));
    const sync = startWorkspaceSync()!;
    await vi.waitFor(() => expect(state.records[id]?.sync.syncStatus).toBe('synced'));
    expect(f.rpc.mock.calls.filter(([name]) => name === 'windowstash_put_v1')).toHaveLength(1); sync.stop();
  });
  it('an old controller cannot continue accessing its native account after a new login', async () => {
    let resolve!: (value: unknown) => void;
    f.rpc.mockImplementation(() => ({ abortSignal: () => new Promise(done => { resolve = done; }) }));
    const sync = startWorkspaceSync()!; await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    f.grant = null; sync.stop();
    resolve({ error: null, data: { protocol: 1, user_id: 'user-A', records: [], deleted: [] } });
    await vi.waitFor(() => expect(f.remove).toHaveBeenCalledOnce());
    expect(state.generation).toBe(0); expect(f.invoke.mock.calls.some(([, value]) => value.action === 'apply')).toBe(false);
  });

  it('applies creation, modification and tombstone hints queued behind failed snapshots without waiting for retry', async () => {
    let rows: unknown[] = [], deleted: unknown[] = [];
    f.rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: null, data: { protocol: 1, user_id: 'user-A', records: rows, deleted } }) }));
    const sync = startWorkspaceSync()!;
    try {
      await vi.waitFor(() => expect(f.invoke.mock.calls.some(([, request]) => request.action === 'release')).toBe(true));
      const changeDuringFailure = async (change: () => Promise<void>, check: () => void) => {
        let reject: ((error: Error) => void) | undefined;
        f.rpc.mockImplementationOnce(() => ({ abortSignal: () => new Promise((_resolve, fail) => { reject = fail; }) }));
        sync.kick();
        await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
        await change(); f.hint!(); reject!(new Error('snapshot interrupted'));
        // waitFor's one-second deadline is below even the first five-second retry.
        await vi.waitFor(check);
        await vi.waitFor(() => expect(f.invoke.mock.calls.at(-1)?.[1].action).toBe('release'));
      };
      const content = { id, name: 'Created', status: 'active' as const, tabs: [], activeTabIndex: 0, createdAt: stamp, updatedAt: stamp };
      const makeRow = async () => ({ id, name: content.name, status: content.status, tabs: [], active_tab_index: 0, created_at: stamp, updated_at: content.updatedAt, user_id: 'user-A', content_hash: await workspaceHash(content) });
      await changeDuringFailure(async () => { rows = [await makeRow()]; }, () => expect(state.records[id]?.content.name).toBe('Created'));
      await changeDuringFailure(async () => {
        content.name = 'Modified'; content.updatedAt = '2026-10-15T00:00:00Z'; rows = [await makeRow()];
      }, () => expect(state.records[id]?.content.name).toBe('Modified'));
      await changeDuringFailure(async () => {
        rows = []; deleted = [{ workspace_id: id, user_id: 'user-A', deleted_at: stamp }];
        f.ready!('CHANNEL_ERROR'); f.ready!('SUBSCRIBED');
      }, () => { expect(state.records[id]).toBeUndefined(); expect(state.remote_deleted[id]).toBe(stamp); });
    } finally { sync.stop(); }
  });
});
