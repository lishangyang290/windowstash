import { diagnosticRef, sanitizeEvent, type Component, type DiagnosticEvent, type TraceContext } from './diagnostics';
/** Bounded local diagnostics. Never pass account data, tokens, names, or tab contents. */
export const SYNC_TRACE_KEY = 'windowstash-sync-trace:v1';
export interface Fields {
  trace?: TraceContext; scope?: string; operationId?: string; parentEventId?: string; trigger?: string;
  source?: string; errorCode?: string; retryAttempt?: number; httpStatus?: number; pending?: number; queueDepth?: number; before?: number; after?: number; blockedByOperationId?: string;
  result?: DiagnosticEvent['result'];
  run?: number; revision?: number; generation?: number; count?: number; deleted?: number;
  elapsedMs?: number; retryMs?: number; changed?: boolean; queued?: boolean;
  workspace?: string; serverAt?: string;
  failure?: 'lease-busy' | 'lease-expired' | 'stale-revision' | 'validation' | 'other';
  action?: 'save' | 'save-close' | 'update' | 'delete' | 'snapshot' | 'put' | 'remove' | 'acquire' | 'read' | 'renew' | 'apply' | 'release';
  status?: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | 'ok' | 'error' | 'other' | 'busy';
}
export type Stage = 'sync.skipped' | 'operation.done' | 'native.publish.queued' | 'sync.coalesced' | 'operation.start' | 'local.deleted' | 'lifecycle.start' | 'lifecycle.account' | 'queue.snapshot' | 'queue.upload' | 'queue.delete' | 'cloud.version' | 'cloud.received' | 'conflict.detected' | 'lease.release.failed' | 'local.persisted' | 'native.publish.start' | 'native.publish.persisted' | 'native.publish.failed' | 'native.publish.skipped'
  | 'native.changed' | 'native.import.start' | 'native.import.done' | 'native.import.failed'
  | 'realtime.start' | 'realtime.status' | 'realtime.database' | 'realtime.event' | 'realtime.stop'
  | 'sync.request' | 'sync.start' | 'sync.done' | 'sync.failed' | 'sync.retry' | 'sync.stop'
  | 'lease.start' | 'lease.acquired' | 'lease.busy' | 'lease.released'
  | 'native.read' | 'native.applied' | 'cloud.start' | 'cloud.done' | 'cloud.failed'
  | 'ui.refresh.start' | 'ui.refresh.done' | 'ui.refresh.failed' | 'ui.committed' | 'lifecycle.online' | 'lifecycle.resume' | 'lifecycle.open';
export interface SyncTrace extends Fields { at: string; context: string; stage: Stage }
const processId = crypto.randomUUID();
let component: Component = 'extension';
declare const __WINDOWSTASH_BUILD_ID__: string;
let buildId = typeof __WINDOWSTASH_BUILD_ID__ === 'string' ? __WINDOWSTASH_BUILD_ID__ : 'development';
export type DiagnosticSink = (event: DiagnosticEvent, scope?: string) => Promise<void>;
let sink: DiagnosticSink | undefined;
let captureScope: (() => string | undefined) | undefined;
let pending = 0;
let dropped = 0;
const inflight = new Set<Promise<void>>();
export function configureDiagnostics(next: { component: Component; buildId?: string; sink: DiagnosticSink; captureScope?: () => string | undefined }) {
  component = next.component; buildId = typeof __WINDOWSTASH_BUILD_ID__ === 'string' ? __WINDOWSTASH_BUILD_ID__ : next.buildId ?? buildId; sink = next.sink; captureScope = next.captureScope;
}
export function traceContext(trigger?: string): TraceContext { return { operationId: crypto.randomUUID(), trigger }; }
export function syncFailure(error: unknown): Fields['failure'] {
  const message = error instanceof Error ? error.message : '';
  if (message === '其他本机进程正在同步，将自动重试') return 'lease-busy';
  if (message === 'sync_lease_expired') return 'lease-expired';
  if (message === 'stale_workspace_revision') return 'stale-revision';
  if (message === '同步数据校验失败，本机数据已保留') return 'validation';
  return 'other';
}
export const flushDiagnostics = async () => { await Promise.all([...inflight]); };
export const diagnosticHealth = () => ({ pending, dropped });
/** Never blocks business execution, never sends a native message per event. */
export function syncTrace(stage: Stage, fields: Fields = {}): TraceContext {
  const id = crypto.randomUUID();
  const trace = fields.trace ?? { operationId: fields.operationId ?? crypto.randomUUID(), trigger: fields.trigger };
  const next = { ...trace, parentEventId: id };
  if (!sink || pending >= 256) { dropped++; return next; }
  const activeSink = sink, activeComponent = component, scope = fields.scope ?? captureScope?.();
  const timestamp = new Date().toISOString();
  pending++;
  const task = Promise.resolve().then(async () => {
    const workspaceRef = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(fields.workspace ?? '') ? await diagnosticRef(fields.workspace!) : undefined;
    const failure = stage.endsWith('.failed'), waiting = stage.endsWith('.busy') || stage.endsWith('.retry') || ['queue.upload', 'queue.delete'].includes(stage) || stage === 'realtime.status' && ['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(fields.status ?? '');
    const event = sanitizeEvent({ id, timestamp, component: activeComponent, event: stage,
      operationId: trace.operationId, parentEventId: fields.parentEventId ?? trace.parentEventId, blockedByOperationId: fields.blockedByOperationId,
      workspaceRef, cloudVersion: fields.serverAt, correlationId: workspaceRef,
      durationMs: fields.elapsedMs, retryAttempt: fields.retryAttempt, errorCode: fields.errorCode ?? fields.failure,
      trigger: fields.trigger ?? trace.trigger,
      level: failure ? 'ERROR' : waiting ? 'WARN' : 'INFO',
      result: fields.result ?? (failure ? 'failed' : waiting ? 'waiting' : stage.endsWith('.start') ? 'started' : stage.endsWith('.stop') ? 'cancelled' : ['.done', '.persisted', '.acquired', '.released', '.applied', '.version', '.received', '.deleted'].some(end => stage.endsWith(end)) ? 'success' : 'observed'),
      devicePlatform: platform(), deviceId: 'unknown', processId, buildId,
      source: fields.source ?? sourceFor(stage), state: { ...fields, context: activeComponent === 'companion' ? 'companion' : globalThis.location?.pathname?.endsWith('/popup.html') ? 'popup' : globalThis.location?.pathname?.endsWith('/options.html') ? 'manager' : globalThis.location?.pathname?.endsWith('/diagnostics.html') ? 'diagnostics' : 'background' },
    });
    if (event) await activeSink(event, scope);
  }).catch(() => { dropped++; }).finally(() => { pending--; inflight.delete(task); });
  inflight.add(task);
  return next;
}
export function platform(): string {
  const name = globalThis.navigator?.userAgent ?? '';
  return /Windows/i.test(name) ? 'windows' : /Mac/i.test(name) ? 'macos' : /Linux/i.test(name) ? 'linux' : 'unknown';
}
function sourceFor(stage: string): string {
  if (stage.startsWith('realtime.')) return 'shared/workspaceRealtime.ts:subscribeWorkspaceChanges';
  if (stage === 'cloud.version' || stage === 'cloud.received' || stage.startsWith('queue.')) return 'shared/workspaceSync.ts:synchronize';
  if (stage.startsWith('cloud.')) return 'shared/syncCloud.ts:rpc';
  if (stage.startsWith('lease.') || ['native.read', 'native.applied', 'queue.upload', 'queue.delete', 'conflict.detected'].includes(stage)) return 'shared/workspaceSync.ts:synchronize';
  if (stage.startsWith('native.publish') || stage === 'local.persisted') return 'src/lib/companion/workspaces.ts';
  if (stage.startsWith('native.import')) return 'src/lib/sync/nativeImport.ts';
  if (stage.startsWith('ui.') || ['lifecycle.open', 'lifecycle.online', 'lifecycle.resume', 'native.changed'].includes(stage)) return 'companion/src/App.tsx';
  return 'shared/realtimeSync.ts:RealtimeSync';
}
