import { describe, expect, it, vi } from 'vitest';
import type { CloudWorkspaceRow, WorkspaceLocalRecord } from '../src/types/workspace';
import { readLibrary, synchronize, resolveSynchronizedConflict, workspaceHash, type LocalExchange, type NativeLibrary } from './workspaceSync';
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', user = 'user-A', stamp = '2026-10-14T01:00:00.000Z';
function record(name = 'Offline'): WorkspaceLocalRecord {
  return { content: { id, name, status: 'active', tabs: [{ title: 'Pinned', url: 'https://example.test/path', pinned: true, position: 0, favIconUrl: 'https://example.test/icon.png' }], activeTabIndex: 0, createdAt: stamp, updatedAt: stamp },
    sync: { syncStatus: 'pending', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: stamp, lastSyncError: null } };
}
async function row(local = record()): Promise<CloudWorkspaceRow> {
  return { id: local.content.id, user_id: user, name: local.content.name, status: local.content.status, tabs: local.content.tabs,
    active_tab_index: local.content.activeTabIndex, created_at: stamp, updated_at: stamp, content_hash: await workspaceHash(local.content) };
}
function fixture() {
  let state: NativeLibrary = { generation: 0, revision: 1, digest: 'digest', records: {}, deleted: [], remote_deleted: {}, delete_ack: [], conflicts: {} };
  let lease = '', parts: string[] = [];
  const exchange: LocalExchange = vi.fn(async (action, payload) => {
    if (action === 'acquire') { if (lease) return { status: 'busy' }; lease = 'a'.repeat(64); return { status: 'acquired', token: lease }; }
    if (action === 'read') {
      if (payload.generation !== undefined && payload.generation !== state.generation) throw new Error('stale_workspace_revision');
      const bytes = new TextEncoder().encode(JSON.stringify(state)), index = Number(payload.index), chunks = Math.ceil(bytes.length / 16384);
      return { status: 'read', generation: state.generation, index, chunks, part: [...bytes.subarray(index * 16384, (index + 1) * 16384)].map(b => b.toString(16).padStart(2, '0')).join('') };
    }
    if (!lease || payload.token !== lease) throw new Error('sync_lease_expired');
    if (action === 'release') { lease = ''; return { status: 'released' }; }
    if (action === 'renew') return { status: 'renewed' };
    if (payload.generation !== state.generation) throw new Error('stale_workspace_revision');
    if (payload.index === 0) parts = [];
    parts.push(String(payload.part));
    if (Number(payload.index) + 1 !== payload.chunks) return { status: 'staged' };
    state = JSON.parse(Buffer.from(parts.join(''), 'hex').toString('utf8')); state.generation++;
    return { status: 'persisted', generation: state.generation };
  });
  const rows = new Map<string, CloudWorkspaceRow>(), deleted = new Map<string, string>();
  const cloud = {
    snapshot: vi.fn(async () => ({ protocol: 1, user_id: user, records: [...rows.values()], deleted: [...deleted].map(([workspace_id, deleted_at]) => ({ workspace_id, user_id: user, deleted_at })) })),
    put: vi.fn(async (local: WorkspaceLocalRecord) => {
      if (deleted.has(local.content.id)) throw new Error('workspace_deleted');
      const current = rows.get(local.content.id);
      if (current && current.updated_at !== local.sync.lastSyncedCloudUpdatedAt && current.content_hash !== await workspaceHash(local.content)) throw new Error('workspace_conflict');
      const result = await row(local); rows.set(result.id, result); return result;
    }),
    remove: vi.fn(async (workspace: string) => { deleted.set(workspace, stamp); rows.delete(workspace); }),
  };
  return { exchange, cloud, rows, deleted, get state() { return state; } };
}
describe('shared local-first synchronization (isolated contract model, no database)', () => {
  it('imports legacy empty-hash rows without rewriting existing cloud data', async () => {
    const f = fixture(); f.rows.set(id, { ...await row(), content_hash: '' });
    await synchronize(f.exchange, f.cloud, user);
    expect(f.state.records[id]?.content.tabs).toEqual(record().content.tabs); expect(f.rows.get(id)?.content_hash).toBe('');
    expect(f.cloud.put).not.toHaveBeenCalled();
  });
  it('resolves conflicts using a fresh server baseline and retains the displaced local version', async () => {
    const f = fixture(), local = record('Local'), remote = await row(record('Remote'));
    f.state.records[id] = local; f.rows.set(id, remote);
    await resolveSynchronizedConflict(f.exchange, f.cloud, user, id, 'cloud');
    expect(f.state.records[id]?.content.name).toBe('Remote'); expect(f.state.conflicts[id]?.[0]?.content.name).toBe('Local');
    f.state.records[id] = record('Chosen local');
    await resolveSynchronizedConflict(f.exchange, f.cloud, user, id, 'local');
    expect(f.rows.get(id)?.name).toBe('Chosen local');
    f.deleted.set(id, stamp); f.rows.delete(id);
    await expect(resolveSynchronizedConflict(f.exchange, f.cloud, user, id, 'local')).rejects.toThrow('工作区已被删除');
  });
  it('uploads offline creations, persists complete downloads, and performs no second write when unchanged', async () => {
    const f = fixture(); f.state.records[id] = record();
    await synchronize(f.exchange, f.cloud, user);
    expect(f.cloud.put).toHaveBeenCalledTimes(1); expect(f.state.records[id]?.sync.syncStatus).toBe('synced');
    expect(await synchronize(f.exchange, f.cloud, user)).toBe(false);
    expect(f.cloud.put).toHaveBeenCalledTimes(1);
    expect((await readLibrary(f.exchange)).records[id]?.content.tabs[0]?.favIconUrl).toContain('icon.png');
  });
  it('downloads without Chrome and can read the full record offline after restart', async () => {
    const f = fixture(); f.rows.set(id, await row());
    await synchronize(f.exchange, f.cloud, user);
    f.cloud.snapshot.mockRejectedValue(new Error('offline'));
    expect((await readLibrary(f.exchange)).records[id]?.content.tabs).toEqual(record().content.tabs);
    const before = structuredClone(f.state);
    await expect(synchronize(f.exchange, f.cloud, user)).rejects.toThrow('offline');
    expect(f.state).toEqual(before);
  });
  it('remote deletion wins over offline edits but retains the entire recoverable local copy', async () => {
    const f = fixture(); f.state.records[id] = record('Offline edits'); f.deleted.set(id, stamp);
    await synchronize(f.exchange, f.cloud, user);
    expect(f.state.records[id]).toBeUndefined(); expect(f.state.conflicts[id]?.[0]?.content.name).toBe('Offline edits');
    expect(f.cloud.put).not.toHaveBeenCalled();
    await synchronize(f.exchange, f.cloud, user); expect(f.state.conflicts[id]).toHaveLength(1);
  });
  it('absence alone never deletes a synced record and never uploads its stale copy', async () => {
    const f = fixture(), local = record(); local.sync.lastSyncedHash = await workspaceHash(local.content); local.sync.lastSyncedCloudUpdatedAt = stamp;
    f.state.records[id] = local;
    await synchronize(f.exchange, f.cloud, user);
    expect(f.state.records[id]?.sync.syncStatus).toBe('conflict'); expect(f.cloud.put).not.toHaveBeenCalled();
    expect(f.state.deleted).toEqual([]);
  });
  it('rejects permission errors, wrong users and malformed snapshots without clearing local records', async () => {
    for (const response of [{ protocol: 1, user_id: 'other', records: [], deleted: [] }, { protocol: 1, user_id: user, records: [], deleted: [{ workspace_id: id, user_id: user, deleted_at: 'bad' }] }]) {
      const f = fixture(); f.state.records[id] = record(); const before = structuredClone(f.state);
      f.cloud.snapshot.mockResolvedValue(response as Awaited<ReturnType<typeof f.cloud.snapshot>>);
      await expect(synchronize(f.exchange, f.cloud, user)).rejects.toThrow('校验'); expect(f.state).toEqual(before);
    }
  });
  it('refuses conflicting devices rather than overwriting either copy', async () => {
    const f = fixture(), base = record('Base'), local = record('Local edits'), remote = await row(record('Remote edits'));
    local.sync.lastSyncedHash = await workspaceHash(base.content); local.sync.lastSyncedCloudUpdatedAt = '2026-10-13T00:00:00.000Z';
    f.state.records[id] = local; f.rows.set(id, remote);
    await synchronize(f.exchange, f.cloud, user);
    expect(f.state.records[id]?.content.name).toBe('Local edits'); expect(f.state.records[id]?.sync.syncStatus).toBe('conflict');
    expect(f.state.conflicts[id]?.[0]?.content.name).toBe('Remote edits'); expect(f.cloud.put).not.toHaveBeenCalled();
  });
  it('persists received deletions before an unrelated upload fails', async () => {
    const f = fixture(); f.deleted.set(other, stamp); f.state.records[id] = record(); f.cloud.put.mockRejectedValue(new Error('offline'));
    await expect(synchronize(f.exchange, f.cloud, user)).rejects.toThrow('offline');
    expect(f.state.deleted).toContain(other); expect(f.state.records[id]?.sync.syncStatus).toBe('pending');
  });
  it('one native lease prevents simultaneous extension and Companion uploads', async () => {
    const f = fixture(); f.state.records[id] = record();
    let release!: () => void;
    f.cloud.snapshot.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { protocol: 1, user_id: user, records: [], deleted: [] }; });
    const first = synchronize(f.exchange, f.cloud, user);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(synchronize(f.exchange, f.cloud, user)).rejects.toThrow('其他本机进程');
    release(); await first; expect(f.cloud.put).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite a local save performed during the cloud request', async () => {
    const f = fixture(); f.rows.set(id, await row());
    f.cloud.snapshot.mockImplementationOnce(async () => { f.state.generation++; f.state.records[id] = record('Newer save'); return { protocol: 1, user_id: user, records: [...f.rows.values()], deleted: [] }; });
    await expect(synchronize(f.exchange, f.cloud, user)).rejects.toThrow('stale_workspace_revision');
    expect(f.state.records[id]?.content.name).toBe('Newer save'); expect(f.cloud.put).not.toHaveBeenCalled();
  });
});
