import type { DiagnosticEvent, Finding } from './diagnostics';

export type Disposition = 'actionable' | 'historical' | 'recovered' | 'routine';
export type Outcome = 'succeeded' | 'recovered' | 'waiting' | 'failed' | 'unknown' | 'cancelled';
interface Contract { name: string; start: string; done: string[]; cancelled: string[] }
const contracts: Record<string, Contract> = {
  operation: { name: '保存 / 工作区操作', start: 'operation.start', done: ['operation.done'], cancelled: [] },
  sync: { name: '同步校准调用', start: 'sync.start', done: ['sync.done'], cancelled: ['sync.stop', 'sync.skipped', 'sync.coalesced'] },
  'native.import': { name: '本机数据导入', start: 'native.import.start', done: ['native.import.done'], cancelled: [] },
  'native.publish': { name: '本机数据提交', start: 'native.publish.start', done: ['native.publish.persisted'], cancelled: ['native.publish.skipped'] },
  cloud: { name: '云端请求', start: 'cloud.start', done: ['cloud.done'], cancelled: [] },
  'ui.refresh': { name: '界面数据读取', start: 'ui.refresh.start', done: ['ui.refresh.done'], cancelled: [] },
  realtime: { name: '实时订阅', start: 'realtime.start', done: [], cancelled: ['realtime.stop'] },
  lock: { name: '本机文件锁操作', start: 'lock.start', done: ['lock.acquired', 'lock.released'], cancelled: [] },
  lease: { name: '本机同步租约', start: 'lease.start', done: ['lease.acquired', 'lease.released'], cancelled: ['lease.busy'] },
};
export const dispositionLabels: Record<Disposition, string> = {
  actionable: '当前待处理', historical: '历史异常或恢复未确认', recovered: '已确认恢复', routine: '普通运行状态',
};
export const outcomeLabels: Record<Outcome, string> = {
  succeeded: '目标已完成', recovered: '失败后确认恢复', waiting: '执行或等待中', failed: '已记录失败', unknown: '结果无法确定', cancelled: '已取消或转交',
};
// Recency controls attention, never recovery. Explicit durable risk does not expire with this window.
const CURRENT_OBSERVATION_MS = 30_000;
const key = (...values: unknown[]) => JSON.stringify(values);
function family(event: string): string | undefined {
  return Object.keys(contracts).find(name => event === contracts[name]!.start || event === `${name}.failed`
    || contracts[name]!.done.includes(event) || contracts[name]!.cancelled.includes(event)
    || name === 'lease' && event === 'lease.release.failed'
    || name === 'sync' && ['sync.retry', 'sync.request', 'queue.snapshot', 'conflict.detected'].includes(event)
    || name === 'realtime' && ['realtime.status', 'realtime.database'].includes(event));
}
const failure = (event: DiagnosticEvent) => event.result === 'failed' && event.errorCode !== 'lease-busy'
  && event.state.failure !== 'lease-busy' && event.errorCode !== 'account-changed';
const persistentError = (event: DiagnosticEvent) => ['local_store_corrupt', 'local_store_full', 'local_store_unavailable'].includes(event.errorCode ?? '');

/** Evidence links remain intact. Only stage ownership and explicit retry ancestry establish completion. */
export function assessOperations(input: DiagnosticEvent[], now: number): Finding[] {
  const events = [...input].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const byId = new Map(events.map(e => [e.id, e]));
  const order = new Map(events.map((e, index) => [e.id, index]));
  const groups = new Map<string, { kind: string; events: DiagnosticEvent[] }>();
  const snapshots = new Map<string, DiagnosticEvent>();
  const conflictSnapshots = new Map<string, DiagnosticEvent>();
  const latestLane = new Map<string, number>();
  const laneFor = (e: DiagnosticEvent, kind: string) => key(e.deviceId, e.component, e.state.context, kind, e.workspaceRef, e.state.action, e.targetRef, e.cloudVersion);
  const descendsFrom = (event: DiagnosticEvent, ancestor: DiagnosticEvent) => {
    const visited = new Set<string>(); let parent = event.parentEventId;
    while (parent && !visited.has(parent)) {
      if (parent === ancestor.id) return true;
      visited.add(parent); const previous = byId.get(parent);
      if (!previous || previous.deviceId !== event.deviceId || previous.processId !== event.processId || previous.operationId !== event.operationId) break;
      parent = previous.parentEventId;
    }
    return false;
  };
  for (const event of events) {
    if (event.event === 'queue.snapshot' && event.source === 'shared/workspaceSync.ts:synchronize') {
      const scope = key(event.deviceId, event.component, event.state.context);
      snapshots.set(scope, event);
      if (typeof event.state.conflicts === 'number') conflictSnapshots.set(scope, event);
    }
    const kind = family(event.event); if (!kind) continue;
    // Observations never join different workspaces, requested content, or explicit versions.
    const parent = byId.get(event.parentEventId ?? '');
    const owner = parent?.event === contracts[kind]!.start && parent.operationId === event.operationId
      && parent.deviceId === event.deviceId && parent.processId === event.processId && parent.component === event.component
      && (!parent.workspaceRef || !event.workspaceRef || parent.workspaceRef === event.workspaceRef)
      && (!parent.targetRef || !event.targetRef || parent.targetRef === event.targetRef)
      && (!parent.state.action || !event.state.action || parent.state.action === event.state.action)
      && (!parent.cloudVersion || !event.cloudVersion || parent.cloudVersion === event.cloudVersion) ? parent : event;
    const operationKey = key(owner.deviceId, owner.operationId, kind, owner.workspaceRef, owner.state.action, owner.targetRef, owner.cloudVersion);
    const group = groups.get(operationKey) ?? { kind, events: [] };
    group.events.push(event); groups.set(operationKey, group);
    latestLane.set(laneFor(event, kind), order.get(event.id)!);
  }
  const assessments: Finding[] = [];
  for (const [operationKey, group] of groups) {
    const contract = contracts[group.kind]!, last = group.events.at(-1)!;
    const starts = group.events.filter(e => e.event === contract.start);
    const failures = group.events.filter(failure);
    const ownedEnd = (start: DiagnosticEvent) => group.events.find(e => order.get(e.id)! > order.get(start.id)!
      && e.processId === start.processId && e.component === start.component
      && (contract.done.includes(e.event) || contract.cancelled.includes(e.event) || failure(e))
      && e.parentEventId === start.id);
    const failedStarts = starts.filter(start => { const end = ownedEnd(start); return end && failure(end); });
    const completed = starts.filter(start => { const end = ownedEnd(start); return end && contract.done.includes(end.event); });
    const coversGoal = (start: DiagnosticEvent) => group.kind === 'cloud'
      ? start.state.action === 'snapshot' || !!start.workspaceRef && (start.state.action === 'remove' || !!start.targetRef || !!start.cloudVersion)
      : !['native.import', 'native.publish'].includes(group.kind) || !!start.targetRef;
    const retryCompletion = failures.length ? completed.find(start => start.trigger === 'retry' && coversGoal(start) && failedStarts.some(previous => descendsFrom(start, previous))
      && failures.every(e => order.get(e.id)! < order.get(start.id)!)) : undefined;
    // A retained terminal can stand on its own; it must not finish an unmatched live attempt.
    const terminal = starts.length ? ownedEnd(starts.at(-1)!) : group.events.filter(e =>
      (contract.done.includes(e.event) || contract.cancelled.includes(e.event) || e.result === 'cancelled')
      && !['started', 'waiting'].includes(e.result)).at(-1);
    const subscriptionReady = group.kind === 'realtime' && (last.event === 'realtime.status' && last.state.status === 'SUBSCRIBED'
      || last.event === 'realtime.database' && last.state.status === 'ok');
    const subscriptionError = group.kind === 'realtime' && group.events.some(e => e.event === 'realtime.status' && ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(String(e.state.status)) || e.event === 'realtime.database' && e.state.status === 'error');
    const recoveredSubscription = subscriptionReady && subscriptionError && starts.some(start => start.id === last.parentEventId
      && start.processId === last.processId && start.component === last.component);
    let outcome: Outcome = retryCompletion || recoveredSubscription ? 'recovered'
      : failures.length ? 'failed'
        : terminal && (contract.cancelled.includes(terminal.event) || terminal.result === 'cancelled') ? 'cancelled'
          : terminal && contract.done.includes(terminal.event) ? 'succeeded'
            : subscriptionReady ? 'succeeded' : 'unknown';
    if (!failures.length && outcome === 'unknown' && now >= Date.parse(last.timestamp) && now - Date.parse(last.timestamp) <= CURRENT_OBSERVATION_MS
      && (starts.length || group.events.some(e => ['sync.retry', 'sync.request', 'lease.busy'].includes(e.event)))) outcome = 'waiting';

    const snapshot = snapshots.get(key(last.deviceId, last.component, last.state.context));
    const conflictSnapshot = conflictSnapshots.get(key(last.deviceId, last.component, last.state.context));
    // Counts refer to the complete account queue, not the number of retained conflict copies.
    const currentConflict = !!conflictSnapshot && group.events.includes(conflictSnapshot) && Number(conflictSnapshot.state.conflicts) > 0;
    if (currentConflict) outcome = 'waiting';
    const pendingRisk = group.kind === 'sync' && !!snapshot && snapshot.operationId === last.operationId
      && ((Number(snapshot.state.pending) > 0) || Number(snapshot.state.deleted) > 0) && failures.length > 0;
    const skippedPending = outcome === 'cancelled' && terminal?.event.endsWith('.skipped')
      && [terminal.state.pending, terminal.state.deleted, terminal.state.conflicts].some(value => Number(value) > 0);
    const skippedError = outcome === 'cancelled' && terminal && [terminal.errorCode, terminal.state.failure, terminal.state.reason]
      .some(code => typeof code === 'string' && !['lease-busy', 'account-changed'].includes(code)
        && (code === terminal.errorCode || ['other', 'timeout', 'validation', 'conflict', 'lease-expired', 'stale-revision'].includes(code)));
    const skippedRisk = skippedPending || skippedError;
    const durableRisk = failures.some(persistentError) || currentConflict || pendingRisk;
    const currentLane = latestLane.get(laneFor(last, group.kind)) === order.get(last.id);
    const fresh = now >= Date.parse(last.timestamp) && now - Date.parse(last.timestamp) <= CURRENT_OBSERVATION_MS;
    const retry = group.events.filter(e => e.event === 'sync.retry').at(-1);
    const retryPending = !!retry && now >= Date.parse(retry.timestamp) && now <= Date.parse(retry.timestamp) + Number(retry.state.retryMs ?? 0) + CURRENT_OBSERVATION_MS;
    const unresolved = failures.length > 0 && outcome !== 'recovered';
    const connectionUncertain = subscriptionError && !subscriptionReady && !group.events.some(e => e.event === 'realtime.stop');
    const actionable = currentConflict || unresolved && (durableRisk || currentLane && (fresh || retryPending))
      || connectionUncertain && currentLane && fresh || skippedRisk && (skippedPending || currentLane && fresh);
    const normalControl = !failures.length && group.events.every(e => ['lease.busy', 'sync.request', 'sync.retry'].includes(e.event)
      || e.event === 'sync.failed' && e.errorCode === 'lease-busy');
    const disposition: Disposition = outcome === 'recovered' ? 'recovered' : actionable ? 'actionable' : normalControl ? 'routine'
      : unresolved || skippedRisk || outcome === 'unknown' || connectionUncertain || group.events.some(e => e.event === 'conflict.detected') ? 'historical' : 'routine';
    const anchor = failures.at(-1) ?? last;
    const evidence = [...new Set([...failures.map(e => e.id), ...group.events.map(e => e.id)])];
    const hypothesis = currentConflict ? `最近完整队列快照记录 ${conflictSnapshot!.state.conflicts} 个未解决冲突，不能用冲突副本数量替代此状态。`
      : outcome === 'recovered' ? '同一目标有直接关联的恢复及完成证据；原失败记录仍保留。'
        : unresolved ? `已记录${contract.name}失败${anchor.errorCode ? `（${anchor.errorCode}）` : ''}；${actionable ? '当前失败或明确持续风险需要处理。' : '缺少关联恢复证据，保留为历史失败；不能据此认定当前仍然故障或已经恢复。'}`
          : outcome === 'succeeded' ? `${contract.name}的完成条件有直接证据；不代表其他操作或所有工作区均已完成。`
            : skippedRisk ? '该阶段已跳过或取消，但仍记录待提交数据或错误线索，需要核实影响；不能据此确认目标完成或此前失败已经恢复。'
              : outcome === 'cancelled' ? '该阶段已明确跳过、取消或转交；不代表目标提交成功，也不证明此前失败已经恢复。'
              : outcome === 'waiting' ? '有近期执行、排队或竞争证据；普通等待和重试不直接构成故障。'
                : '现有记录不足以确定最终结果；日志轮转、采集范围或进程结束均可能造成证据缺口。';
    assessments.push({ operationKey, kind: group.kind, outcome, disposition,
      severity: durableRisk ? 'error' : failures.length || connectionUncertain || skippedRisk ? 'warning' : 'info',
      confidence: failures.length || currentConflict || ['succeeded', 'recovered', 'cancelled'].includes(outcome) ? 'confirmed' : 'insufficient',
      symptom: currentConflict ? '完整队列快照仍存在未解决冲突' : `${contract.name}：${outcomeLabels[outcome]}`,
      evidence, firstAbnormal: anchor.id, lastSuccess: retryCompletion ? ownedEnd(retryCompletion)?.id : undefined,
      recoveryEvidence: retryCompletion ? [retryCompletion.id, ownedEnd(retryCompletion)!.id] : recoveredSubscription ? [last.id] : [],
      devices: [...new Set(group.events.map(e => e.deviceId))], components: [...new Set(group.events.map(e => e.component))], source: [...new Set(group.events.map(e => e.source))],
      hypothesis, check: actionable ? `检查 ${anchor.source} 的目标、错误码及尚未完成的阶段；仅用对应目标的完成证据确认恢复。` : '可查看原始事件与阶段记录；缺少证据时不推断成功或失败。',
      missing: unresolved ? ['原失败目标的明确恢复或覆盖证据'] : skippedRisk ? ['跳过原因及该目标的后续处理证据'] : outcome === 'unknown' ? ['对应操作的结束、取消或覆盖证据'] : [],
    });
  }
  return assessments;
}
