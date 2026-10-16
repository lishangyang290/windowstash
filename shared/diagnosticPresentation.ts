/** UI-only grouping: never alters exported findings, evidence, or causality. */
import type { DiagnosticBundle, DiagnosticEvent, Finding } from './diagnostics';

export interface IssueGroup {
  key: string;
  representative: Finding;
  findings: Finding[];
  anchor?: DiagnosticEvent;
  timestamp: string;
  confidence: Finding['confidence'];
  eventIds: string[];
}
const rank: Record<Finding['confidence'], number> = { confirmed: 3, suspected: 2, insufficient: 1 };

/** Group by exact operation, explicit causal links, or shared workspace + exact cloud version. */
export function groupDiagnosticFindings(bundle: DiagnosticBundle): IssueGroup[] {
  const byId = new Map(bundle.events.map(e => [e.id, e]));
  const anchors = bundle.findings.map(finding => byId.get(finding.firstAbnormal ?? '') ?? finding.evidence.map(id => byId.get(id)).find(Boolean));
  const parents = new Map<string, string>();
  const operationKey = (e: DiagnosticEvent) => `operation:${e.deviceId}:${e.operationId}`;
  const root = (key: string): string => {
    const trail: string[] = [];
    while (parents.has(key) && parents.get(key) !== key) { trail.push(key); key = parents.get(key)!; }
    for (const previous of trail) parents.set(previous, key);
    return key;
  };
  // A versioned stage and an unversioned stage can belong to the same operation.
  for (const anchor of bundle.events) if (anchor.workspaceRef && anchor.cloudVersion) {
    parents.set(root(`version:${anchor.workspaceRef}:${anchor.cloudVersion}`), root(operationKey(anchor)));
  }
  for (const link of bundle.links) {
    const from = byId.get(link.from), to = byId.get(link.to);
    if (from && to) parents.set(root(operationKey(from)), root(operationKey(to)));
  }
  const groups = new Map<string, IssueGroup>();
  bundle.findings.forEach((finding, index) => {
    const anchor = anchors[index];
    const key = anchor ? root(operationKey(anchor)) : `unlinked:${index}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, representative: finding, findings: [finding], anchor,
        timestamp: anchor?.timestamp ?? bundle.exportedAt, confidence: finding.confidence, eventIds: [...finding.evidence] });
    } else {
      existing.findings.push(finding);
      existing.eventIds.push(...finding.evidence);
      if (rank[finding.confidence] > rank[existing.confidence] || finding.confidence === existing.confidence && anchor && anchor.timestamp > (existing.anchor?.timestamp ?? '')) {
        existing.confidence = finding.confidence;
        existing.representative = finding;
        existing.anchor = anchor;
      }
      if (anchor && anchor.timestamp > existing.timestamp) existing.timestamp = anchor.timestamp;
    }
  });
  return [...groups.values()].map(group => ({ ...group, eventIds: [...new Set(group.eventIds)] }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Explicit parent links or exact cloud-version relation only. */
export function evidenceForOperation(bundle: DiagnosticBundle, active: DiagnosticEvent): DiagnosticEvent[] {
  const events = bundle.events;
  const ids = new Set(events.filter(e => e.operationId === active.operationId && e.deviceId === active.deviceId).map(e => e.id));
  const adjacent = new Map<string, string[]>();
  for (const link of bundle.links) {
    adjacent.set(link.from, [...(adjacent.get(link.from) ?? []), link.to]);
    adjacent.set(link.to, [...(adjacent.get(link.to) ?? []), link.from]);
  }
  const queue = [...ids];
  for (let i = 0; i < queue.length; i++) for (const related of adjacent.get(queue[i]!) ?? []) {
    if (!ids.has(related)) { ids.add(related); queue.push(related); }
  }
  return events.filter(e => ids.has(e.id));
}
