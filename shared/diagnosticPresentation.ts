/** Group assessments only by their operation/target identity; evidence links never merge faults. */
import type { DiagnosticBundle, DiagnosticEvent, Finding } from './diagnostics';
export interface IssueGroup {
  key: string; representative: Finding; findings: Finding[]; anchor?: DiagnosticEvent;
  timestamp: string; confidence: Finding['confidence']; eventIds: string[];
}
export function groupDiagnosticFindings(bundle: DiagnosticBundle): IssueGroup[] {
  const byId = new Map(bundle.events.map(e => [e.id, e]));
  const groups = new Map<string, IssueGroup>();
  for (const finding of bundle.findings) {
    const anchor = byId.get(finding.firstAbnormal ?? '') ?? finding.evidence.map(id => byId.get(id)).find(Boolean);
    const key = finding.operationKey ?? (anchor ? JSON.stringify([anchor.deviceId, anchor.operationId, anchor.workspaceRef, anchor.targetRef, anchor.cloudVersion]) : `unlinked:${groups.size}`);
    const existing = groups.get(key);
    if (existing) {
      existing.findings.push(finding); existing.eventIds.push(...finding.evidence);
      if (anchor && anchor.timestamp > existing.timestamp) existing.timestamp = anchor.timestamp;
      if (finding.confidence === 'confirmed' && existing.confidence !== 'confirmed') {
        existing.representative = finding; existing.anchor = anchor; existing.confidence = finding.confidence;
      }
    } else groups.set(key, { key, representative: finding, findings: [finding], anchor,
      timestamp: finding.evidence.map(id => byId.get(id)?.timestamp).filter((time): time is string => !!time).sort().at(-1) ?? bundle.exportedAt,
      confidence: finding.confidence, eventIds: [...finding.evidence] });
  }
  return [...groups.values()].map(g => ({ ...g, eventIds: [...new Set(g.eventIds)] })).sort((a,b) => b.timestamp.localeCompare(a.timestamp));
}
/** Same scoped operation and direct context only; no transitive subscription/version expansion. */
export function evidenceForOperation(bundle: DiagnosticBundle, active: DiagnosticEvent): DiagnosticEvent[] {
  const byId = new Map(bundle.events.map(e => [e.id, e]));
  const compatible = (e: DiagnosticEvent) => (!active.workspaceRef || !e.workspaceRef || active.workspaceRef === e.workspaceRef)
    && (!active.targetRef || !e.targetRef || active.targetRef === e.targetRef)
    && (!active.cloudVersion || !e.cloudVersion || active.cloudVersion === e.cloudVersion);
  const ids = new Set(bundle.events.filter(e => e.operationId === active.operationId && e.deviceId === active.deviceId && compatible(e)).map(e => e.id));
  for (const link of bundle.links) if (link.from === active.id || link.to === active.id) {
    const related = byId.get(link.from === active.id ? link.to : link.from);
    if (related && compatible(related)) ids.add(related.id);
  }
  return bundle.events.filter(e => ids.has(e.id));
}
