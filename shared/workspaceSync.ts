import type { CloudWorkspaceRow, WorkspaceContent, WorkspaceLocalRecord } from '../src/types/workspace';

export interface NativeLibrary {
  revision: number; digest: string; generation: number;
  records: Record<string, WorkspaceLocalRecord>; deleted: string[];
  remote_deleted: Record<string, string>; delete_ack: string[];
  conflicts: Record<string, WorkspaceLocalRecord[]>;
}
export type LocalExchange = (action: string, payload: Record<string, unknown>) => Promise<unknown>;
export interface CloudSnapshot { protocol: 1; user_id: string; records: CloudWorkspaceRow[]; deleted: { workspace_id: string; user_id: string; deleted_at: string }[] }
export interface SyncCloud {
  snapshot(): Promise<unknown>;
  put(record: WorkspaceLocalRecord, hash: string): Promise<unknown>;
  remove(id: string): Promise<void>;
}
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BYTES = 16 * 1024 * 1024, CHUNK = 16_384;
function fail(): never { throw new Error('同步数据校验失败，本机数据已保留'); }
export async function workspaceHash(content: WorkspaceContent): Promise<string> {
  const stable = { name: content.name, status: content.status,
    tabs: [...content.tabs].sort((a, b) => a.position - b.position).map(({ title, url, position, pinned }) => ({ title, url, position, pinned })),
    activeTabIndex: content.activeTabIndex };
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable))))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function readLibrary(exchange: LocalExchange): Promise<NativeLibrary> {
  const parts: Uint8Array[] = []; let chunks = 1, generation: number | undefined;
  for (let index = 0; index < chunks; index++) {
    const reply = await exchange('read', { index, generation }) as { status: string; generation: number; chunks: number; index: number; part: string };
    if (reply?.status !== 'read' || reply.index !== index || !Number.isSafeInteger(reply.generation) || reply.generation < 0
      || (generation !== undefined && generation !== reply.generation) || !Number.isSafeInteger(reply.chunks) || reply.chunks < 1 || reply.chunks > MAX_BYTES / CHUNK
      || (index > 0 && chunks !== reply.chunks) || typeof reply.part !== 'string' || reply.part.length > CHUNK * 2 || !/^(?:[a-f0-9]{2})*$/.test(reply.part)) fail();
    generation = reply.generation; chunks = reply.chunks;
    parts.push(Uint8Array.from(reply.part.match(/../g) ?? [], pair => parseInt(pair, 16)));
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as NativeLibrary;
  if (state.generation !== generation || !state.records || !Array.isArray(state.deleted) || !state.remote_deleted || !Array.isArray(state.delete_ack) || !state.conflicts) fail();
  return state;
}
export async function writeLibrary(exchange: LocalExchange, state: NativeLibrary, token: string): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(state)); if (bytes.length > MAX_BYTES) fail();
  const chunks = Math.ceil(bytes.length / CHUNK);
  for (let index = 0; index < chunks; index++) {
    const part = [...bytes.subarray(index * CHUNK, (index + 1) * CHUNK)].map(b => b.toString(16).padStart(2, '0')).join('');
    const reply = await exchange('apply', { token, generation: state.generation, index, chunks, part }) as { status: string };
    if (reply?.status !== (index + 1 === chunks ? 'persisted' : 'staged')) fail();
  }
}
function validRow(row: CloudWorkspaceRow, user: string): boolean {
  return UUID.test(row?.id ?? '') && row.user_id === user && typeof row.name === 'string' && row.name.length > 0 && [...row.name].length <= 200
    && ['active', 'review', 'revision', 'archived'].includes(row.status) && Number.isInteger(row.active_tab_index) && row.active_tab_index >= 0
    && Number.isFinite(Date.parse(row.updated_at)) && Number.isFinite(Date.parse(row.created_at)) && (row.content_hash === '' || /^[a-f0-9]{64}$/.test(row.content_hash))
    && Array.isArray(row.tabs) && row.tabs.every(tab => typeof tab.title === 'string' && typeof tab.url === 'string' && typeof tab.pinned === 'boolean'
      && Number.isInteger(tab.position) && tab.position >= 0 && (tab.favIconUrl === undefined || typeof tab.favIconUrl === 'string'));
}
function content(row: CloudWorkspaceRow): WorkspaceContent {
  return { id: row.id, name: row.name, status: row.status, tabs: row.tabs, activeTabIndex: row.active_tab_index, createdAt: row.created_at, updatedAt: row.updated_at };
}
async function checkedRow(value: unknown, user: string): Promise<CloudWorkspaceRow> {
  const row = value as CloudWorkspaceRow;
  if (!validRow(row, user)) fail();
  const hash = await workspaceHash(content(row));
  // The pre-migration schema permits an empty hash. Normalize without mutating the cloud row.
  if (row.content_hash === '') return { ...row, content_hash: hash };
  if (hash !== row.content_hash) fail();
  return row;
}
function downloaded(row: CloudWorkspaceRow): WorkspaceLocalRecord {
  const now = new Date();
  return { content: content(row), sync: { syncStatus: 'synced', lastSyncedAt: now.toISOString(), lastSyncedHash: row.content_hash,
    lastSyncedCloudUpdatedAt: row.updated_at, localExpiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), lastSyncError: null } };
}
function conflict(record: WorkspaceLocalRecord, message: string): WorkspaceLocalRecord {
  return { ...record, sync: { ...record.sync, syncStatus: 'conflict', lastSyncError: message } };
}

/** One native lease owns upload, for both processes. No cloud absence is a deletion. */
export async function synchronize(exchange: LocalExchange, cloud: SyncCloud, user: string): Promise<boolean> {
  const lease = await exchange('acquire', {}) as { status: string; token?: string };
  if (lease?.status === 'busy') throw new Error('其他本机进程正在同步，将自动重试');
  if (lease?.status !== 'acquired' || !/^[a-f0-9]{64}$/.test(lease.token ?? '')) fail();
  const token = lease.token!;
  try {
    let state = await readLibrary(exchange);
    const before = JSON.stringify(state);
    const raw = await cloud.snapshot() as CloudSnapshot;
    if (raw?.protocol !== 1 || raw.user_id !== user || !Array.isArray(raw.records) || !Array.isArray(raw.deleted)) fail();
    const rows = new Map<string, CloudWorkspaceRow>();
    for (const value of raw.records) { const row = await checkedRow(value, user); if (rows.has(row.id)) fail(); rows.set(row.id, row); }
    // Validate the entire response before any local or cloud mutations.
    const deletions = new Map<string, string>();
    for (const item of raw.deleted) {
      if (!UUID.test(item?.workspace_id ?? '') || item.user_id !== user || !Number.isFinite(Date.parse(item.deleted_at)) || rows.has(item.workspace_id) || deletions.has(item.workspace_id)) fail();
      deletions.set(item.workspace_id, item.deleted_at);
    }
    for (const [id, stamp] of deletions) {
      if (state.remote_deleted[id] && state.remote_deleted[id] !== stamp) fail();
      state.remote_deleted[id] = stamp;
      if (!state.deleted.includes(id)) state.deleted.push(id);
      if (!state.delete_ack.includes(id)) state.delete_ack.push(id);
      const local = state.records[id];
      if (local && local.sync.syncStatus !== 'synced') {
        const versions = state.conflicts[id] ??= [];
        if (!versions.some(r => JSON.stringify(r) === JSON.stringify(local))) versions.push(local);
      }
      delete state.records[id];
    }
    const renew = async () => {
      const reply = await exchange('renew', { token }) as { status: string };
      if (reply.status !== 'renewed') fail();
    };
    const uploads: string[] = [];
    for (const [id, local] of Object.entries(state.records)) {
      const remote = rows.get(id), hash = await workspaceHash(local.content);
      if (!remote) {
        if (local.sync.lastSyncedHash || local.sync.lastSyncedCloudUpdatedAt) {
          state.records[id] = conflict(local, '云端记录缺失，已保留本机副本，禁止自动重新上传'); continue;
        }
        if (local.sync.syncStatus === 'conflict') continue;
        uploads.push(id); continue;
      }
      if (hash === remote.content_hash) {
        if (local.sync.syncStatus !== 'synced' || local.sync.lastSyncedCloudUpdatedAt !== remote.updated_at) state.records[id] = downloaded(remote);
        continue;
      }
      const changedLocal = hash !== local.sync.lastSyncedHash;
      if (changedLocal && (local.sync.syncStatus === 'conflict' || !local.sync.lastSyncedCloudUpdatedAt || remote.updated_at !== local.sync.lastSyncedCloudUpdatedAt)) {
        state.records[id] = conflict(local, '本机与云端均有更新，已保留两个版本');
        const versions = state.conflicts[id] ??= [], copy = downloaded(remote);
        if (!versions.some(r => r.sync.lastSyncedCloudUpdatedAt === remote.updated_at)) versions.push(copy);
      } else if (changedLocal) {
        uploads.push(id);
      } else state.records[id] = downloaded(remote);
      rows.delete(id);
    }
    for (const [id, row] of rows) if (!state.deleted.includes(id) && !state.records[id]) state.records[id] = downloaded(row);
    // Downloads/deletions are durably committed even if a subsequent upload fails.
    let changed = JSON.stringify(state) !== before;
    if (changed) { await renew(); await writeLibrary(exchange, state, token); state = await readLibrary(exchange); }
    const uploadBase = JSON.stringify(state);
    for (const id of state.deleted) {
      if (state.delete_ack.includes(id)) continue;
      await renew(); await cloud.remove(id); state.delete_ack.push(id);
    }
    for (const id of uploads) {
      const local = state.records[id]; if (!local || state.deleted.includes(id)) continue;
      await renew();
      const row = await checkedRow(await cloud.put(local, await workspaceHash(local.content)), user);
      if (row.id !== id) fail();
      state.records[id] = downloaded(row);
    }
    if (JSON.stringify(state) !== uploadBase) { await renew(); await writeLibrary(exchange, state, token); changed = true; }
    return changed;
  } finally { await exchange('release', { token }).catch(() => undefined); }
}

export async function resolveSynchronizedConflict(exchange: LocalExchange, cloud: SyncCloud, user: string, id: string, choice: 'local' | 'cloud') {
  const lease = await exchange('acquire', {}) as { status: string; token?: string };
  if (lease.status !== 'acquired' || !/^[a-f0-9]{64}$/.test(lease.token ?? '')) throw new Error('其他本机进程正在同步，请稍后重试');
  const token = lease.token!;
  try {
    const state = await readLibrary(exchange), local = state.records[id];
    if (!local || state.deleted.includes(id)) throw new Error('工作区已被删除');
    const snapshot = await cloud.snapshot() as CloudSnapshot;
    if (snapshot?.protocol !== 1 || snapshot.user_id !== user || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.deleted)) fail();
    if (snapshot.deleted.some(item => item.workspace_id === id)) throw new Error('工作区已被删除');
    const value = snapshot.records.find(row => row.id === id); if (!value) throw new Error('云端记录缺失，本机副本已保留，禁止重新上传旧 ID');
    const remote = await checkedRow(value, user), versions = state.conflicts[id] ??= [];
    if (!versions.some(item => JSON.stringify(item.content) === JSON.stringify(local.content))) versions.push(local);
    if (choice === 'cloud') state.records[id] = downloaded(remote);
    else {
      const pending = { ...local, sync: { ...local.sync, syncStatus: 'pending' as const, lastSyncedHash: remote.content_hash, lastSyncedCloudUpdatedAt: remote.updated_at } };
      await exchange('renew', { token });
      const result = await checkedRow(await cloud.put(pending, await workspaceHash(pending.content)), user);
      if (result.id !== id) fail(); state.records[id] = downloaded(result);
    }
    await exchange('renew', { token }); await writeLibrary(exchange, state, token);
  } finally { await exchange('release', { token }).catch(() => undefined); }
}
