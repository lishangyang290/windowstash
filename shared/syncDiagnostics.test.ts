import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureDiagnostics, flushDiagnostics, diagnosticHealth, syncFailure, syncTrace, traceContext } from './syncDiagnostics';
import { diagnosticErrorCode, diagnosticRef, importBundle, makeBundle, MAX_EVENTS, MAX_STORE_BYTES, RETENTION_MS, retainEvents, sanitizeEvent, type DiagnosticEvent } from './diagnostics';
import { diagnosticWriter } from './diagnosticStore';
let events: DiagnosticEvent[];
beforeEach(() => { events = []; configureDiagnostics({ component: 'extension', sink: async e => { events.push({ ...e, deviceId: 'a'.repeat(64) }); } }); });
afterEach(async () => { await flushDiagnostics(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('matches legacy stage endings and lease contention without treating unrelated successes as completion', async () => {
  const lease = syncTrace('lease.start'); syncTrace('lease.busy', { trace: lease });
  const cloud = traceContext(); syncTrace('cloud.start', { trace: cloud, action: 'snapshot' }); syncTrace('cloud.done', { trace: cloud, action: 'snapshot' });
  const pending = syncTrace('cloud.start', { action: 'put' }); syncTrace('native.applied', { trace: pending });
  await flushDiagnostics();
  const findings = makeBundle(events, {}, Date.now() + 60_000).findings.filter(f => f.symptom.includes('长时间缺少结束'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.firstAbnormal).toBe(pending.parentEventId);
});
it('records import failure codes without exporting raw error text', () => {
  expect(diagnosticErrorCode(new Error('账号已变化，请重新操作'))).toBe('account-changed');
  expect(diagnosticErrorCode(new Error('invalid_workspace_chunk'))).toBe('invalid_workspace_chunk');
  expect(diagnosticErrorCode(new Error('同步数据校验失败，本机数据已保留'))).toBe('validation');
  expect(diagnosticErrorCode(new Error('PRIVATE TOKEN / URL / WORKSPACE'))).toBe('other');
});
it('captures an actual operation span without recording workspace contents, identity or raw errors', async () => {
  const trace = syncTrace('operation.start', { trace: traceContext(), workspace: '11111111-1111-4111-8111-111111111111' });
  syncTrace('local.persisted', { trace, revision: 2 });
  await flushDiagnostics();
  const start = events.find(e => e.event === 'operation.start')!, end = events.find(e => e.event === 'local.persisted')!;
  expect(end.operationId).toBe(start.operationId); expect(end.parentEventId).toBe(start.id);
  expect(start.workspaceRef).toBe(await diagnosticRef('11111111-1111-4111-8111-111111111111'));
  expect(makeBundle(events).links).toContainEqual({ from: start.id, to: end.id, basis: 'parent-event' });
  expect(syncFailure(new Error('private credentials or tab content'))).toBe('other');
});
it('does not propagate diagnostic storage failure or unbounded backlog into business execution', async () => {
  configureDiagnostics({ component: 'extension', sink: async () => { throw new Error('disk full'); } });
  const before = diagnosticHealth().dropped;
  expect(() => { for (let i = 0; i < 400; i++) syncTrace('sync.failed'); }).not.toThrow();
  await flushDiagnostics(); expect(diagnosticHealth().dropped).toBeGreaterThan(before);
});
it('enforces duration, byte, count and age limits and survives a failed writer', async () => {
  syncTrace('local.persisted'); await flushDiagnostics();
  const base = events[0]!;
  const retained = retainEvents(Array.from({ length: 5000 }, () => ({ ...base, id: crypto.randomUUID() })));
  expect(retained.length).toBeLessThanOrEqual(MAX_EVENTS);
  expect(new TextEncoder().encode(JSON.stringify(retained)).length).toBeLessThanOrEqual(MAX_STORE_BYTES);
  expect(retainEvents([{ ...base, timestamp: new Date(Date.now() - RETENTION_MS - 1).toISOString() }])).toEqual([]);
  const writer = diagnosticWriter({ read: async () => [], write: async () => { throw new Error('disk full'); } });
  await writer.append(base); expect(writer.health().dropped).toBe(1);
});
it('removes unknown fields and sensitive errors on capture and again on import/export', async () => {
  syncTrace('realtime.event', { workspace: 'https://private.invalid/tab?secret=password', serverAt: 'not-a-timestamp', errorCode: 'secret-token' });
  await flushDiagnostics();
  const bad = { ...events[0]!, password: 'PASSWORD', url: 'https://private.invalid', title: 'Private title', state: { count: 3, email: 'a@example.com', token: 'TOKEN' } };
  const bundle = importBundle(JSON.stringify({ ...makeBundle([bad]), summary: 'PRIVATE SUMMARY', environment: { token: 'TOKEN' }, events: [bad] }));
  const raw = JSON.stringify(bundle);
  for (const secret of ['PASSWORD', 'private.invalid', 'Private title', 'a@example.com', 'TOKEN', 'PRIVATE SUMMARY', 'secret-token']) expect(raw).not.toContain(secret);
  expect(bundle.events[0]!.state).toEqual({ count: 3 });
  expect(events[0]!.workspaceRef).toBeUndefined(); expect(events[0]!.cloudVersion).toBeUndefined();
});
it('never builds causal links from similar timestamps or workspace ID alone', async () => {
  const workspace = '11111111-1111-4111-8111-111111111111';
  syncTrace('cloud.version', { workspace, serverAt: '2026-10-15T00:00:00.000001Z' });
  await flushDiagnostics();
  configureDiagnostics({ component: 'companion', sink: async e => { events.push({ ...e, deviceId: 'b'.repeat(64) }); } });
  syncTrace('realtime.event', { workspace, serverAt: '2026-10-15T00:00:00.000002Z' });
  await flushDiagnostics(); expect(makeBundle(events).links).toEqual([]);
  syncTrace('realtime.event', { workspace, serverAt: '2026-10-15T00:00:00.000001Z' });
  await flushDiagnostics(); expect(makeBundle(events).links.filter(l => l.basis === 'workspace-cloud-version')).toHaveLength(1);
});

it('imports Windows ISO timestamps and macOS native epoch timestamps using the same wire format', async () => {
  syncTrace('cloud.version', { workspace: '11111111-1111-4111-8111-111111111111', serverAt: '2026-10-15T08:00:00.123456+08:00' });
  await flushDiagnostics();
  const windows = { ...events[0]!, devicePlatform: 'windows', deviceSource: 'native' as const };
  const mac = sanitizeEvent({ ...windows, id: crypto.randomUUID(), operationId: crypto.randomUUID(), event: 'realtime.event', source: 'shared/workspaceRealtime.ts:subscribeWorkspaceChanges', component: 'companion', devicePlatform: 'macos', deviceId: 'b'.repeat(64), timestamp: Date.now(), cloudVersion: '2026-10-15T00:00:00.123456Z' })!;
  const bundle = importBundle(JSON.stringify(makeBundle([windows, mac])));
  expect(bundle.environment.platforms).toContain('windows'); expect(bundle.environment.platforms).toContain('macos');
  expect(bundle.events.every(e => typeof e.timestamp === 'string')).toBe(true);
  expect(bundle.links.some(link => link.basis === 'workspace-cloud-version')).toBe(true);
});
