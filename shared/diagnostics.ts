import { assessOperations, type Disposition, type Outcome } from './diagnosticOperations';
/** Diagnostic wire format shared by both products. Only allowlisted scalars cross this boundary. */
export const DIAGNOSTIC_SCHEMA = 'windowstash.diagnostics/1' as const;
export const RETENTION_MS = 7 * 86_400_000;
export const MAX_EVENTS = 4_000;
export const MAX_STORE_BYTES = 2 * 1024 * 1024;
export type Component = 'extension' | 'companion' | 'native-host' | 'companion-rust';
export interface TraceContext { operationId: string; parentEventId?: string; trigger?: string; workspace?: string }
export interface DiagnosticEvent {
  id: string; timestamp: string; level: 'INFO' | 'WARN' | 'ERROR'; component: Component;
  event: string; operationId: string; parentEventId?: string; correlationId?: string; blockedByOperationId?: string;
  workspaceRef?: string; cloudVersion?: string; targetRef?: string; durationMs?: number;
  result: 'started' | 'success' | 'waiting' | 'failed' | 'cancelled' | 'observed';
  devicePlatform: string; deviceId: string; deviceSource?: 'native' | 'profile' | 'app' | 'unknown'; processId: string; buildId: string;
  source: string; trigger?: string; errorCode?: string; retryAttempt?: number;
  state: Record<string, number | boolean | string>;
}
const token = /^[a-zA-Z0-9_.:/-]{1,140}$/;
const ref = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeErrorCode = /^(?:[0-9A-Z]{5}|PGRST\d{3}|sync_lease_expired|stale_workspace_revision|local_store_[a-z_]+|invalid_workspace_[a-z_]+|lease-busy|lease-expired|stale-revision|validation|other|timeout|account-changed)$/;
export function diagnosticErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && safeErrorCode.test(code)) return code;
  if (safeErrorCode.test(message)) return message;
  if (message.startsWith('账号已变化') || message === '请先登录 WindowStash') return 'account-changed';
  if (message === '本机工作区通道超时；原数据已保留，请重试') return 'timeout';
  if (message === '同步数据校验失败，本机数据已保留') return 'validation';
  return 'other';
}
export async function diagnosticRef(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const sources = new Set(["src/lib/supabase/workspaceRemoteRepository.ts:observed", "companion/native-host/src/workspaces.rs", "companion/native-host/src/diagnostics.rs:ObservedLock", "companion/native-host/src/workspaces.rs:sync_action", "companion/src/App.tsx", "companion/src/lib/browserAuth.ts:acceptBrowserGrant", "companion/src/lib/diagnostics.ts:initializeDiagnostics", "shared/realtimeSync.ts:RealtimeSync", "shared/syncCloud.ts:rpc", "shared/workspaceRealtime.ts:subscribeWorkspaceChanges", "shared/workspaceSync.ts:synchronize", "src/features/workspaces/workspaceService.ts", "src/lib/companion/workspaces.ts", "src/lib/storage/diagnostics.ts:initializeDiagnostics", "src/lib/storage/syncLogRepository.ts:add", "src/lib/storage/tombstoneRepository.ts:add", "src/lib/storage/workspaceRepository.ts:saveContent", "src/lib/sync/nativeImport.ts", "src/lib/sync/nativeSync.ts:syncNative", "src/lib/sync/pendingSync.ts:schedulePendingSync", "src/lib/sync/pendingSync.ts:syncPendingWorkspaces"]);
function cloudVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts) return;
  const seconds = new Date(parts[1]! + parts[3]!);
  if (!Number.isFinite(seconds.getTime())) return;
  return seconds.toISOString().slice(0, 19) + '.' + (parts[2] ?? '').padEnd(9, '0') + 'Z';
}
const numeric = new Set(['run', 'revision', 'generation', 'count', 'deleted', 'conflicts', 'retryMs', 'pending', 'queueDepth', 'httpStatus', 'leaseRemainingMs', 'dropped', 'before', 'after']);
const flags = new Set(['changed', 'queued']);
const enums = new Set(['action', 'status', 'failure', 'reason', 'context']);
const enumValues = new Set(['popup', 'manager', 'background', 'diagnostics', 'companion', 'save', 'save-close', 'update', 'delete', 'snapshot', 'put', 'remove', 'acquire', 'read', 'renew', 'apply', 'release', 'SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', 'ok', 'error', 'other', 'busy', 'lease-busy', 'lease-expired', 'stale-revision', 'validation', 'account-changed', 'stop', 'startup', 'retry', 'realtime', 'ready', 'manual', 'native-change', 'pending', 'synced', 'failed', 'conflict', 'timeout']);
/** Used again on import/export, never trusts an arbitrary JSON object or error message. */
export function sanitizeEvent(value: unknown): DiagnosticEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as DiagnosticEvent;
  if (!uuid.test(v.id ?? '') || !uuid.test(v.operationId ?? '') || !Number.isFinite(new Date(v.timestamp).getTime())
    || !['extension', 'companion', 'native-host', 'companion-rust'].includes(v.component)
    || !token.test(v.event ?? '') || !Object.hasOwn(eventNames, v.event) || !['INFO', 'WARN', 'ERROR'].includes(v.level)
    || !['started', 'success', 'waiting', 'failed', 'cancelled', 'observed'].includes(v.result)) return null;
  const state: DiagnosticEvent['state'] = {};
  for (const [key, val] of Object.entries(v.state ?? {})) {
    if (numeric.has(key) && typeof val === 'number' && Number.isFinite(val) && val >= 0) state[key] = val;
    if (flags.has(key) && typeof val === 'boolean') state[key] = val;
    if (enums.has(key) && typeof val === 'string' && enumValues.has(val)) state[key] = val;
  }
  const clean: DiagnosticEvent = {
    id: v.id, timestamp: new Date(v.timestamp).toISOString(), component: v.component, level: v.level,
    event: v.event, operationId: v.operationId, result: v.result, state,
    source: sources.has(v.source) ? v.source : 'unknown',
    deviceId: ref.test(v.deviceId ?? '') ? v.deviceId : 'unknown',
    deviceSource: ['native', 'profile', 'app'].includes(v.deviceSource ?? '') ? v.deviceSource : 'unknown',
    processId: uuid.test(v.processId ?? '') ? v.processId : 'unknown',
    devicePlatform: ['windows', 'macos', 'linux', 'unknown'].includes(v.devicePlatform) ? v.devicePlatform : 'unknown',
    buildId: /^(?:[a-f0-9]{7,40}|[0-9]+\.[0-9]+\.[0-9]+|development)$/.test(v.buildId ?? '') ? v.buildId : 'development',
  };
  if (uuid.test(v.parentEventId ?? '')) clean.parentEventId = v.parentEventId;
  if (uuid.test(v.blockedByOperationId ?? '')) clean.blockedByOperationId = v.blockedByOperationId;
  if (ref.test(v.workspaceRef ?? '')) clean.workspaceRef = v.workspaceRef;
  if (ref.test(v.targetRef ?? '')) clean.targetRef = v.targetRef;
  if (ref.test(v.correlationId ?? '')) clean.correlationId = v.correlationId;
  const version = cloudVersion(v.cloudVersion); if (version) clean.cloudVersion = version;
  if (typeof v.durationMs === 'number' && Number.isFinite(v.durationMs) && v.durationMs >= 0) clean.durationMs = Math.round(v.durationMs);
  if (Number.isSafeInteger(v.retryAttempt) && v.retryAttempt! >= 0) clean.retryAttempt = v.retryAttempt;
  if (v.trigger && enumValues.has(v.trigger)) clean.trigger = v.trigger;
  // Error codes are enums, SQLSTATE, or known transport codes; never arbitrary error text.
  if (v.errorCode && safeErrorCode.test(v.errorCode)) clean.errorCode = v.errorCode;
  return clean;
}
export function retainEvents(events: DiagnosticEvent[], now = Date.now()): DiagnosticEvent[] {
  const kept = events.filter(e => Date.parse(e.timestamp) >= now - RETENTION_MS && Date.parse(e.timestamp) <= now + 300_000).slice(-MAX_EVENTS);
  let bytes = 2, start = kept.length;
  while (start > 0) { const size = new TextEncoder().encode(JSON.stringify(kept[start - 1])).length + 1; if (bytes + size > MAX_STORE_BYTES) break; bytes += size; start--; }
  return kept.slice(start);
}
export interface Finding {
  operationKey?: string; kind?: string; outcome?: Outcome; disposition?: Disposition;
  severity?: 'info' | 'warning' | 'error'; recoveryEvidence?: string[];
  confidence: 'confirmed' | 'suspected' | 'insufficient'; symptom: string;
  evidence: string[]; lastSuccess?: string; firstAbnormal?: string;
  devices: string[]; components: string[]; source: string[];
  hypothesis: string; check: string; missing: string[];
}
export const eventNames: Record<string, string> = {
  'sync.coalesced': '同步请求已合并到后续校准',
  'sync.skipped': '未关联本机同步通道，转入扩展同步',
  'operation.done': '工作区操作完成', 'native.publish.queued': '本机投影请求已排队',
  'operation.start': '工作区操作开始', 'local.persisted': '本地保存完成', 'local.deleted': '本地删除标记已保存',
  'native.publish.start': '开始提交 Native Host', 'native.publish.persisted': 'Native Host 已持久化', 'native.publish.failed': '本机通道未确认写入', 'native.publish.skipped': '本机提交已跳过',
  'native.changed': '本机版本发生变化', 'native.import.start': '开始导入本机数据', 'native.import.done': '本机数据导入完成', 'native.import.failed': '本机数据导入失败',
  'lease.start': '等待同步租约', 'lease.acquired': '同步租约已获取', 'lease.busy': '其他进程持有同步租约', 'lease.released': '同步租约已释放', 'lease.release.failed': '同步租约释放未确认',
  'lock.start': '等待 Native Host 文件锁', 'lock.acquired': 'Native Host 文件锁已获取', 'lock.released': 'Native Host 文件锁已释放', 'lock.failed': 'Native Host 文件锁获取失败',
  'native.read': '本机数据读取完成', 'native.applied': '本机数据校准完成', 'native.persisted': '本机文件持久化完成',
  'sync.request': '同步任务已请求', 'sync.start': '同步任务开始', 'sync.done': '同步任务完成', 'sync.failed': '同步失败，等待重试', 'sync.retry': '同步重试已安排', 'sync.stop': '同步控制器已停止',
  'queue.snapshot': '同步队列状态已记录', 'queue.upload': '等待云端上传', 'queue.delete': '等待云端删除',
  'cloud.start': '开始请求 Supabase', 'cloud.done': '云端请求已确认', 'cloud.failed': '云端请求失败',
  'cloud.version': '云端写入版本已确认', 'cloud.received': '收到云端工作区版本', 'conflict.detected': '检测到版本冲突',
  'realtime.start': '开始订阅 Realtime', 'realtime.status': 'Realtime 连接状态变化', 'realtime.database': 'Realtime 数据库订阅状态变化', 'realtime.event': '收到云端工作区更新', 'realtime.stop': 'Realtime 事件处理已停止',
  'ui.refresh.start': '开始刷新界面', 'ui.refresh.done': '界面数据读取完成', 'ui.refresh.failed': '界面数据读取失败', 'ui.committed': 'Companion 界面已更新',
  'lifecycle.start': '组件进程已启动', 'lifecycle.account': '账号上下文已切换', 'lifecycle.online': '网络恢复触发同步', 'lifecycle.resume': '系统恢复触发同步', 'lifecycle.open': '打开界面触发校准',
};
export function differentDevice(a: DiagnosticEvent, b: DiagnosticEvent): boolean {
  if (a.deviceId === b.deviceId) return false;
  return a.deviceSource === 'native' && b.deviceSource === 'native' && ref.test(a.deviceId) && ref.test(b.deviceId)
    || a.devicePlatform !== 'unknown' && b.devicePlatform !== 'unknown' && a.devicePlatform !== b.devicePlatform;
}
export function analyze(events: DiagnosticEvent[], now = Date.now()): Finding[] {
  return assessOperations(events, now);
}
export interface DiagnosticBundle {
  schema: typeof DIAGNOSTIC_SCHEMA; exportedAt: string; events: DiagnosticEvent[];
  coverage: Record<string, string>; environment: Record<string, string>;
  range: { from: string | null; to: string | null }; findings: Finding[]; summary: string;
  links: { from: string; to: string; basis: 'parent-event' | 'workspace-cloud-version' }[];
}
export function makeBundle(input: DiagnosticEvent[], coverage: Record<string, string> = {}, now = Date.now()): DiagnosticBundle {
  const started = performance.now();
  const events = [...new Map(input.map(sanitizeEvent).filter((e): e is DiagnosticEvent => !!e).map(e => [e.id, e])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-20000);
  const ids = new Set(events.map(e => e.id));
  const links: DiagnosticBundle['links'] = events.filter(e => e.parentEventId && ids.has(e.parentEventId)).map(e => ({ from: e.parentEventId!, to: e.id, basis: 'parent-event' }));
  const versions = new Map<string, DiagnosticEvent[]>();
  for (const e of events) if (e.workspaceRef && e.cloudVersion) { const key = `${e.workspaceRef}:${e.cloudVersion}`; const group = versions.get(key) ?? []; group.push(e); versions.set(key, group); }
  for (const group of versions.values()) {
    const origins = [...new Map(group.filter(e => e.event === 'cloud.version').map(e => [e.deviceId, e])).values()].slice(-16);
    for (const b of group.filter(e => ['realtime.event', 'cloud.received', 'ui.committed', 'native.applied'].includes(e.event))) for (const a of origins) if (a.deviceId !== b.deviceId && links.length < 40000) links.push({ from: a.id, to: b.id, basis: 'workspace-cloud-version' });
  }
  const analysisStart = performance.now();
  const findings = analyze(events, now);
  performance.measure('windowstash.diagnostics.analyze', { start: analysisStart, duration: performance.now() - analysisStart });
  performance.measure('windowstash.diagnostics.makeBundle', { start: started, duration: performance.now() - started });
  return { schema: DIAGNOSTIC_SCHEMA, exportedAt: new Date(now).toISOString(), events, coverage,
    environment: { platforms: [...new Set(events.map(e => e.devicePlatform))].join(', '), builds: [...new Set(events.map(e => e.buildId))].join(', '), retention: '7 days / 4000 events / 2 MiB per store', clock: 'UTC wall clock; cross-device differences include unknown clock skew' },
    range: { from: events[0]?.timestamp ?? null, to: events.at(-1)?.timestamp ?? null }, findings, links,
    summary: [`WindowStash 诊断摘要：${events.length} 项证据，${findings.filter(f => f.disposition === 'actionable').length} 项当前待处理，${findings.filter(f => f.disposition === 'historical').length} 项历史或未确认，${findings.filter(f => f.disposition === 'recovered').length} 项确认恢复，${findings.filter(f => f.disposition === 'routine').length} 项普通状态。`, ...findings.filter(f => f.disposition === 'actionable').map(f => `[${f.severity}; ${f.confidence}] ${f.symptom}\n${f.check}\n证据缺口：${f.missing.join('；') || '无'}`)].join('\n\n') };
}
export function importBundle(raw: string): DiagnosticBundle {
  if (new TextEncoder().encode(raw).length > 20 * 1024 * 1024) throw new Error('诊断文件超过 20 MiB');
  const value = JSON.parse(raw) as DiagnosticBundle;
  if (value.schema !== DIAGNOSTIC_SCHEMA || !Array.isArray(value.events) || value.events.length > 20_000) throw new Error('不支持的诊断文件格式');
  // Recompute summaries and findings: imported prose and metadata are untrusted.
  return makeBundle(value.events, { imported: '离线导入；记录完整性及设备时钟未经独立验证' });
}
