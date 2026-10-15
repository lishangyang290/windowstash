import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { configureDiagnostics, flushDiagnostics, traceContext } from './syncDiagnostics';
import { makeBundle, importBundle, type DiagnosticEvent } from './diagnostics';
import { synchronize, workspaceHash, type NativeLibrary, type LocalExchange } from './workspaceSync';
import { syncCloud } from './syncCloud';
import { RealtimeSync } from './realtimeSync';
import { subscribeWorkspaceChanges } from './workspaceRealtime';

const id = '11111111-1111-4111-8111-111111111111', stamp = '2026-10-15T00:00:00.123456Z', user = 'fixture-user';
let events: DiagnosticEvent[];
const controllers: RealtimeSync[] = [];
beforeEach(() => {
  events = [];
  configureDiagnostics({ component: 'extension', sink: async e => { events.push({ ...e, deviceId: 'a'.repeat(64), devicePlatform: 'windows' }); } });
});
afterEach(async () => { controllers.splice(0).forEach(c => c.stop()); await flushDiagnostics(); vi.useRealTimers(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const trace = traceContext('manual');
  let state: NativeLibrary = { generation: 0, revision: 1, digest: 'fixture', records: {}, deleted: [], remote_deleted: {}, delete_ack: [], conflicts: {}, diagnostics: { [id]: trace } };
  const content = { id, name: 'PRIVATE WORKSPACE', status: 'active' as const, tabs: [{ title: 'PRIVATE TITLE', url: 'https://private.invalid/path?token=PRIVATE', position: 0, pinned: false }], activeTabIndex: 0, createdAt: stamp, updatedAt: stamp };
  state.records[id] = { content, sync: { syncStatus: 'pending', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: stamp, lastSyncError: null } };
  const row = { id, user_id: user, name: content.name, status: content.status, tabs: content.tabs, active_tab_index: 0, created_at: stamp, updated_at: stamp, content_hash: await workspaceHash(content) };
  let lease = '', parts = '';
  const exchange: LocalExchange = vi.fn(async (action, payload) => {
    if (action === 'acquire') { if (lease) return { status: 'busy' }; lease = 'a'.repeat(64); return { status: 'acquired', token: lease }; }
    if (action === 'read') return { status: 'read', generation: state.generation, chunks: 1, index: 0, part: Buffer.from(JSON.stringify(state)).toString('hex') };
    if (payload.token !== lease) throw new Error('sync_lease_expired');
    if (action === 'renew') return { status: 'renewed' };
    if (action === 'release') { lease = ''; return { status: 'released' }; }
    if (payload.index === 0) parts = '';
    parts += payload.part;
    if (Number(payload.index) + 1 < Number(payload.chunks)) return { status: 'staged' };
    state = JSON.parse(Buffer.from(parts, 'hex').toString()); state.generation++; return { status: 'persisted' };
  });
  const gates: Record<string, Promise<void> | undefined> = {};
  let malformed = false, errorCode: string | undefined;
  const rpc = vi.fn((name: string) => ({ abortSignal: async () => {
    await gates[name];
    return { error: errorCode ? { code: errorCode, message: 'PRIVATE TOKEN SHOULD NEVER LEAK' } : null, data: malformed ? { protocol: 0 } : name === 'windowstash_snapshot_v1' ? { protocol: 1, user_id: user, records: [], deleted: [] } : name === 'windowstash_put_v1' ? row : null };
  } }));
  return { exchange, cloud: syncCloud({ rpc }), rpc, gates, trace, get state() { return state; }, malformed: () => { malformed = true; }, fail: (code: string) => { errorCode = code; } };
}
const exported = async (now = Date.now()) => { await flushDiagnostics(); return importBundle(JSON.stringify(makeBundle(events, { test: 'isolated fault injection; no real accounts or cloud' }, now))); };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await flushDiagnostics(); };

it('exports evidence distinguishing native lease contention from cloud failures', async () => {
  const f = await fixture(); await f.exchange('acquire', {});
  await expect(synchronize(f.exchange, f.cloud, user)).rejects.toThrow('其他本机进程');
  const bundle = await exported();
  expect(f.rpc).not.toHaveBeenCalled(); expect(f.state.records[id]?.sync.syncStatus).toBe('pending');
  expect(bundle.findings.some(x => x.confidence === 'confirmed' && x.source.includes('shared/workspaceSync.ts:synchronize') && x.symptom.includes('租约'))).toBe(true);
  expect(bundle.events.some(x => x.event === 'cloud.start')).toBe(false);
});
it('records a real pending RPC before completion and exports its precise code path', async () => {
  const f = await fixture(), gate = deferred(); f.gates.windowstash_put_v1 = gate.promise;
  const run = synchronize(f.exchange, f.cloud, user, f.trace);
  await vi.waitFor(() => expect(f.rpc.mock.calls.some(([name]) => name === 'windowstash_put_v1')).toBe(true));
  await flushDiagnostics();
  const bundle = makeBundle(events, {}, Date.now() + 60_000);
  expect(bundle.events.some(e => e.event === 'cloud.start' && e.state.action === 'put')).toBe(true);
  expect(bundle.events.some(e => e.event === 'cloud.done' && e.state.action === 'put')).toBe(false);
  expect(f.state.records[id]?.sync.syncStatus).toBe('pending');
  expect(bundle.findings.some(finding => finding.symptom.includes('长时间') && finding.source.includes('shared/syncCloud.ts:rpc'))).toBe(true);
  gate.resolve(); await run;
  expect(f.state.records[id]?.sync.syncStatus).toBe('synced');
});
it('does not claim a remote receive or a Realtime failure when no event was delivered', async () => {
  const f = await fixture(); await synchronize(f.exchange, f.cloud, user, f.trace);
  await flushDiagnostics();
  const bundle = makeBundle(events, { companion: 'no receive evidence available' }, Date.now() + 60_000);
  expect(bundle.findings.some(f => f.confidence === 'insufficient' && f.symptom.includes('另一设备'))).toBe(true);
  expect(bundle.links.some(l => l.basis === 'workspace-cloud-version')).toBe(false);
});
it('receives an actual subscription callback then isolates calibration validation failure', async () => {
  const f = await fixture();
  let received!: (change: { table: string; eventType: string; new: Record<string, unknown> }) => void;
  const channel = { on: vi.fn((type: string, _filter: unknown, callback: ((change: { table: string; eventType: string; new: Record<string, unknown> }) => void) | ((payload: { extension: string; status: string }) => void)) => { if (type === 'postgres_changes') received = callback as typeof received; return channel; }), subscribe: vi.fn() };
  const client = { channel: () => channel, removeChannel: async () => 'ok' };
  const controller = new RealtimeSync((hint, ready) => subscribeWorkspaceChanges(client, user, (_payload, trace) => hint(trace), ready), trace => synchronize(f.exchange, f.cloud, user, trace));
  controllers.push(controller); controller.start();
  await vi.waitFor(() => expect(f.state.records[id]?.sync.syncStatus).toBe('synced'));
  f.malformed(); received({ table: 'workspaces', eventType: 'UPDATE', new: { id, updated_at: stamp } });
  await vi.waitFor(() => expect(f.rpc.mock.calls.filter(([name]) => name === 'windowstash_snapshot_v1').length).toBe(2));
  await tick(); const bundle = await exported();
  const receivedEvent = bundle.events.find(e => e.event === 'realtime.event')!;
  const failed = bundle.events.find(e => e.event === 'sync.failed' && e.errorCode === 'validation')!;
  expect(failed.operationId).toBe(receivedEvent.operationId);
  expect(bundle.findings.some(f => f.source.includes('shared/workspaceSync.ts:synchronize') && f.confidence === 'confirmed')).toBe(true);
  expect(bundle.events.some(e => e.event === 'sync.retry' && e.retryAttempt === 1)).toBe(true);
});
it('identifies the operation blocking a queued trigger without inventing a deadlock', async () => {
  const gate = deferred(), reconcile = vi.fn(() => gate.promise);
  const controller = new RealtimeSync(() => () => {}, reconcile); controllers.push(controller); controller.start();
  controller.kick('native-change'); await tick();
  const bundle = makeBundle(events, {}, Date.now() + 60_000);
  const request = bundle.events.find(e => e.event === 'sync.request' && e.state.queued)!;
  expect(request.blockedByOperationId).toBe(bundle.events.find(e => e.event === 'sync.start')!.operationId);
  expect(reconcile).toHaveBeenCalledOnce();
  expect(bundle.findings.some(f => f.symptom.includes('前序任务') && f.confidence === 'suspected')).toBe(true);
  gate.resolve(); await tick();
});
it('records actual retry after an interrupted controller restarts with durable pending work', async () => {
  const f = await fixture(); f.fail('42501');
  const first = new RealtimeSync(() => () => {}, trace => synchronize(f.exchange, f.cloud, user, trace));
  controllers.push(first); first.start(); await tick(); first.stop();
  expect(f.state.records[id]?.sync.syncStatus).toBe('pending');
  const second = new RealtimeSync(() => () => {}, trace => synchronize(f.exchange, f.cloud, user, trace));
  controllers.push(second); second.start(); await tick();
  const bundle = await exported();
  expect(bundle.events.filter(e => e.event === 'sync.start')).toHaveLength(2);
  expect(bundle.events.some(e => e.event === 'sync.stop' && e.result === 'cancelled')).toBe(true);
  expect(bundle.events.some(e => e.errorCode === '42501')).toBe(true);
});
it('exports a reproducible deletion-upload failure with RPC, retry and source evidence for code repair', async () => {
  const f = await fixture(); delete f.state.records[id]; f.state.deleted.push(id);
  const gate = deferred(); f.gates.windowstash_delete_v1 = gate.promise;
  const controller = new RealtimeSync(() => () => {}, trace => synchronize(f.exchange, f.cloud, user, trace));
  controllers.push(controller); controller.start();
  await vi.waitFor(() => expect(f.rpc.mock.calls.some(([name]) => name === 'windowstash_delete_v1')).toBe(true));
  expect(f.state.delete_ack).toEqual([]);
  await flushDiagnostics(); const waiting = makeBundle(events, {}, Date.now() + 60_000);
  expect(waiting.findings.some(f => f.source.includes('shared/syncCloud.ts:rpc') && f.symptom.includes('长时间'))).toBe(true);
  f.fail('42501'); gate.resolve(); await tick();
  const bundle = await exported();
  expect(f.state.delete_ack).toEqual([]);
  expect(bundle.events.some(e => e.event === 'cloud.failed' && e.state.action === 'remove' && e.errorCode === '42501')).toBe(true);
  expect(bundle.events.some(e => e.event === 'sync.retry')).toBe(true);
  expect(bundle.summary).toContain('shared/syncCloud.ts:rpc');
  expect(JSON.stringify(bundle)).not.toMatch(/PRIVATE|private\.invalid|fixture-user/);
  if (process.env.WINDOWSTASH_DIAGNOSTIC_CASE) await writeFile(process.env.WINDOWSTASH_DIAGNOSTIC_CASE, JSON.stringify(bundle, null, 2), 'utf8');
});
it('keeps Realtime disconnect distinct from actual receive and detects missing resubscribe evidence', async () => {
  let status!: (value: string) => void;
  const channel = { on: vi.fn(), subscribe: (callback: typeof status) => { status = callback; } };
  const stop = subscribeWorkspaceChanges({ channel: () => channel, removeChannel: async () => 'ok' }, user, () => {}, () => {});
  status('SUBSCRIBED'); status('CHANNEL_ERROR'); await tick();
  expect((await exported()).findings.some(f => f.symptom.includes('重新订阅'))).toBe(true);
  status('SUBSCRIBED'); await tick();
  // Distinct callbacks may share wall-clock milliseconds; evidence order breaks ties.
  expect(events.some(e => e.event === 'realtime.event')).toBe(false); stop();
});
