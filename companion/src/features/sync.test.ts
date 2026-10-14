import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceHash, type NativeLibrary } from '../../../shared/workspaceSync';
const f = vi.hoisted(() => ({ grant: { instance_id: 'instance-A', login_request: 'login-A', config: { url: 'https://fixture.test' }, session: { user: { id: 'user-A' } } } as { instance_id: string; login_request: string; config: { url: string }; session: { user: { id: string } } } | null,
  invoke: vi.fn(), rpc: vi.fn(), channel: vi.fn(), remove: vi.fn(), filters: [] as unknown[], ready: null as ((status: string) => void) | null, hint: null as (() => void) | null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: f.invoke }));
vi.mock('../lib/browserAuth', () => ({ currentBrowserGrant: () => f.grant, grantIdentity: (grant: NonNullable<typeof f.grant>) => JSON.stringify([grant.instance_id, grant.config.url, grant.session.user.id]) }));
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc: f.rpc, channel: f.channel, removeChannel: f.remove }) }));
import { startWorkspaceSync } from './sync';
const id = '11111111-1111-4111-8111-111111111111', stamp = '2026-10-14T00:00:00Z';
let state: NativeLibrary;
beforeEach(() => {
  vi.clearAllMocks(); f.filters = []; f.hint = null; f.ready = null;
  f.grant = { instance_id: 'instance-A', login_request: 'login-A', config: { url: 'https://fixture.test' }, session: { user: { id: 'user-A' } } };
  state = { generation: 0, revision: 1, digest: 'fixture', records: {}, deleted: [], remote_deleted: {}, delete_ack: [], conflicts: {} };
  const channel = { on: vi.fn((_event, filter, hint) => { f.filters.push(filter); f.hint = hint; return channel; }), subscribe: vi.fn(ready => { f.ready = ready; return channel; }) };
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
    expect(f.filters).toContainEqual({ event: 'INSERT', schema: 'public', table: 'workspace_tombstones', filter: 'user_id=eq.user-A' });
    sync.stop(); expect(f.remove).toHaveBeenCalledOnce();
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
});
