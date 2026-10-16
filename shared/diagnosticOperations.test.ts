import { expect, it } from 'vitest';
import { makeBundle, type DiagnosticEvent } from './diagnostics';
import { groupDiagnosticFindings } from './diagnosticPresentation';

const now = Date.parse('2026-10-16T08:00:00Z');
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const operationId = uuid(), processId = uuid();
function event(name: string, fields: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return { id: uuid(), operationId, processId, timestamp: new Date(now - 1000).toISOString(), component: 'extension',
    deviceId: 'a'.repeat(64), devicePlatform: 'windows', deviceSource: 'native', buildId: 'development',
    event: name, level: 'INFO', result: 'observed', source: 'shared/workspaceSync.ts:synchronize', state: {}, ...fields };
}
const analyze = (events: DiagnosticEvent[], time = now) => makeBundle(events, {}, time);
const current = (events: DiagnosticEvent[], time = now) => analyze(events, time).findings.filter(f => f.disposition === 'actionable');
function failed(fields: Partial<DiagnosticEvent> = {}) {
  const start = event('cloud.start', { result: 'started', ...fields });
  const end = event('cloud.failed', { result: 'failed', errorCode: '42501', ...fields, parentEventId: start.id });
  return [start, end];
}
it('keeps ordinary competition, retries, and slow successful goals out of current faults', () => {
  const start = event('sync.start'), done = event('sync.done', { parentEventId: start.id, result: 'success', durationMs: 90_000 });
  const bundle = analyze([start, event('lease.busy'), event('sync.failed', { result: 'failed', errorCode: 'lease-busy' }), event('sync.retry'), done]);
  expect(bundle.findings.every(f => f.disposition === 'routine')).toBe(true);
  expect(bundle.findings.find(f => f.kind === 'sync')?.outcome).toBe('succeeded');
});
it('retains historical failures without inventing recovery, and does not time out missing endings into faults', () => {
  const bundle = analyze([...failed(), event('native.import.start')], now + 60_000);
  expect(bundle.findings.map(f => [f.disposition, f.outcome])).toEqual([['historical', 'failed'], ['historical', 'unknown']]);
  expect(bundle.events.some(e => e.errorCode === '42501')).toBe(true);
  expect(bundle.findings[0]).toMatchObject({ confidence: 'confirmed', severity: 'warning', disposition: 'historical' });
});
it('requires explicit retry ancestry and matching goal completion for confirmed recovery', () => {
  const [start, error] = failed({ state: { action: 'snapshot' } });
  const retry = event('cloud.start', { parentEventId: error!.id, trigger: 'retry', state: { action: 'snapshot' } });
  const done = event('cloud.done', { parentEventId: retry.id, result: 'success', state: { action: 'snapshot' } });
  const bundle = analyze([start!, error!, retry, done]);
  expect(bundle.findings).toHaveLength(1);
  expect(bundle.findings[0]).toMatchObject({ disposition: 'recovered', outcome: 'recovered', recoveryEvidence: [retry.id, done.id] });
  expect(bundle.events).toHaveLength(4); expect(bundle.links).toHaveLength(3);
});
it.each(['operation', 'workspace', 'target', 'version', 'process', 'stage', 'unrelated'] as const)('does not close a failure with an unrelated %s success', dimension => {
  const fields = { workspaceRef: 'b'.repeat(64), targetRef: 'c'.repeat(64), cloudVersion: '2026-10-16T00:00:00Z' };
  const [start, error] = failed(fields);
  const change: Partial<DiagnosticEvent> = dimension === 'operation' ? { operationId: uuid() }
    : dimension === 'workspace' ? { workspaceRef: 'd'.repeat(64) } : dimension === 'target' ? { targetRef: 'd'.repeat(64) }
      : dimension === 'version' ? { cloudVersion: '2026-10-16T00:00:01Z' } : dimension === 'process' ? { processId: uuid() } : {};
  const retry = event(dimension === 'stage' ? 'operation.start' : 'cloud.start', { ...fields, ...change, trigger: 'retry', parentEventId: dimension === 'unrelated' ? undefined : error!.id });
  const done = event(dimension === 'stage' ? 'operation.done' : 'cloud.done', { ...fields, ...change, parentEventId: retry.id, result: 'success' });
  const bundle = analyze([start!, error!, retry, done]);
  expect(bundle.findings.some(f => f.outcome === 'failed' && f.evidence.includes(error!.id))).toBe(true);
  expect(bundle.findings.some(f => f.disposition === 'recovered')).toBe(false);
});
it('preserves an explicitly pending failed queue beyond the observation window', () => {
  const start = event('sync.start');
  const snapshot = event('queue.snapshot', { parentEventId: start.id, state: { pending: 1, conflicts: 0 } });
  const error = event('sync.failed', { parentEventId: start.id, result: 'failed', errorCode: '42501' });
  expect(current([start, snapshot, error], now + 86_400_000)).toHaveLength(1);
});
it('uses complete conflict state, not old conflict events, copy counts, or a local completion', () => {
  const start = event('sync.start'), conflict = event('conflict.detected', { state: { count: 20 } });
  expect(current([start, conflict])).toHaveLength(0);
  const snapshot = event('queue.snapshot', { state: { conflicts: 2 } });
  const done = event('sync.done', { parentEventId: start.id, result: 'success' });
  expect(current([start, conflict, snapshot, done], now + 60_000)).toHaveLength(1);
  const next = event('queue.snapshot', { operationId: uuid(), state: { conflicts: 0 } });
  expect(current([start, conflict, snapshot, done, next])).toHaveLength(0);
  expect(analyze([start, conflict, snapshot, done, next]).findings.some(f => f.disposition === 'recovered')).toBe(false);
});
it.each(['shared/workspaceSync.ts:synchronize', 'src/lib/sync/pendingSync.ts:syncPendingWorkspaces'])('does not let an incomplete queue observation from %s clear known conflict state', source => {
  const snapshot = event('queue.snapshot', { state: { conflicts: 2 } });
  const unrelated = event('queue.snapshot', { operationId: uuid(), source, state: { pending: 0 } });
  expect(current([snapshot, unrelated])).toHaveLength(1);
});
it('retains all events and links and does not cap away current failures behind historical noise', () => {
  const events = [...failed(), ...Array.from({ length: 250 }, () => event('native.import.start', { operationId: uuid() }))];
  const bundle = analyze(events);
  expect(bundle.events).toHaveLength(events.length); expect(bundle.links).toHaveLength(1);
  expect(groupDiagnosticFindings(bundle).filter(g => g.representative.disposition === 'actionable')).toHaveLength(1);
  expect(bundle.findings).toHaveLength(251);
});
it('allows only opaque target hashes and numeric conflict state across the wire', () => {
  const bundle = analyze([event('cloud.start', { targetRef: 'PRIVATE', state: { conflicts: 2, token: 'PRIVATE' } }), event('cloud.start', { targetRef: 'b'.repeat(64) })]);
  expect(bundle.events[0]!.targetRef).toBeUndefined(); expect(bundle.events[0]!.state).toEqual({ conflicts: 2 });
  expect(bundle.events[1]!.targetRef).toBe('b'.repeat(64)); expect(JSON.stringify(bundle)).not.toContain('PRIVATE');
});
it('keeps durable integrity faults actionable and preserves release failures', () => {
  expect(current(failed({ errorCode: 'local_store_corrupt' }), now + 86_400_000)).toHaveLength(1);
  const release = event('lease.release.failed', { result: 'failed', errorCode: 'other' });
  expect(current([release])[0]?.evidence).toContain(release.id);
});
it('does not reinterpret a causal link as a retry or permit a partial stage to complete the root', () => {
  const [start, error] = failed();
  const next = event('cloud.start', { parentEventId: error!.id });
  const done = event('cloud.done', { parentEventId: next.id, result: 'success' });
  expect(analyze([start!, error!, next, done]).findings[0]?.outcome).toBe('failed');
  const root = event('operation.start');
  const local = event('native.publish.start', { parentEventId: root.id });
  const persisted = event('native.publish.persisted', { parentEventId: local.id, result: 'success' });
  expect(analyze([root, local, persisted]).findings.find(f => f.kind === 'operation')?.outcome).toBe('waiting');
});
it('does not confirm a write recovery without evidence of the requested target', () => {
  const [start, error] = failed({ workspaceRef: 'b'.repeat(64), state: { action: 'put' } });
  const retry = event('cloud.start', { workspaceRef: start!.workspaceRef, state: { action: 'put' }, trigger: 'retry', parentEventId: error!.id });
  const done = event('cloud.done', { workspaceRef: retry.workspaceRef, state: retry.state, parentEventId: retry.id });
  expect(analyze([start!, error!, retry, done]).findings[0]?.outcome).toBe('failed');
  const targetRef = 'c'.repeat(64);
  expect(analyze([start!, error!, retry, done].map(e => ({ ...e, targetRef }))).findings[0]?.outcome).toBe('recovered');
});
it('keeps a failed operation in its observed retry schedule actionable, without alarming on retries alone', () => {
  const start = event('sync.start'), error = event('sync.failed', { result: 'failed', parentEventId: start.id, errorCode: '42501' });
  const retry = event('sync.retry', { parentEventId: start.id, state: { retryMs: 300_000 } });
  expect(current([start, error, retry], now + 60_000)).toHaveLength(1);
  expect(current([start, retry], now + 60_000)).toHaveLength(0);
});
