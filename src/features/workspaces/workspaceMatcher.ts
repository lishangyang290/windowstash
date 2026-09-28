import type { WorkspaceLocalRecord } from '@/types/workspace';

export interface MatchableTab {
  url?: string;
  pinned?: boolean;
  index: number;
}

interface TabIdentity {
  url: string;
  pinned: boolean;
}

function currentTabs(tabs: MatchableTab[]): TabIdentity[] {
  return [...tabs]
    .sort((a, b) => a.index - b.index)
    .map((tab) => ({ url: tab.url || 'about:blank', pinned: Boolean(tab.pinned) }));
}

function savedTabs(record: WorkspaceLocalRecord): TabIdentity[] {
  return [...record.content.tabs]
    .sort((a, b) => a.position - b.position)
    .map(({ url, pinned }) => ({ url, pinned }));
}

function multisetOverlap(left: string[], right: string[]): number {
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  let overlap = 0;
  for (const value of right) {
    const count = counts.get(value) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(value, count - 1);
    }
  }
  return overlap;
}

function orderedOverlap(left: string[], right: string[]): number {
  const previous = new Array<number>(right.length + 1).fill(0);
  for (const leftValue of left) {
    const next = [...previous];
    for (let index = 1; index <= right.length; index += 1) {
      next[index] = leftValue === right[index - 1]
        ? (previous[index - 1] ?? 0) + 1
        : Math.max(previous[index] ?? 0, next[index - 1] ?? 0);
    }
    previous.splice(0, previous.length, ...next);
  }
  return previous[right.length] ?? 0;
}

function isExact(left: TabIdentity[], right: TabIdentity[]): boolean {
  return left.length === right.length
    && left.every((tab, index) => tab.url === right[index]!.url && tab.pinned === right[index]!.pinned);
}

function similarity(left: TabIdentity[], right: TabIdentity[]): number {
  const largestSize = Math.max(left.length, right.length);
  if (!largestSize) return 0;
  const leftUrls = left.map((tab) => tab.url);
  const rightUrls = right.map((tab) => tab.url);
  const urlCoverage = multisetOverlap(leftUrls, rightUrls) / largestSize;
  const orderScore = orderedOverlap(leftUrls, rightUrls) / largestSize;
  const pinnedScore = multisetOverlap(
    left.map((tab) => `${tab.url}\u0000${tab.pinned}`),
    right.map((tab) => `${tab.url}\u0000${tab.pinned}`),
  ) / largestSize;
  const countScore = Math.min(left.length, right.length) / largestSize;
  return urlCoverage * 0.55 + orderScore * 0.2 + pinnedScore * 0.15 + countScore * 0.1;
}

export function matchWorkspace(
  tabs: MatchableTab[],
  records: WorkspaceLocalRecord[],
): WorkspaceLocalRecord | null {
  const current = currentTabs(tabs);
  if (!current.length) return null;

  const candidates = records.map((record) => ({ record, tabs: savedTabs(record) }));
  const exact = candidates.filter((candidate) => isExact(current, candidate.tabs));
  if (exact.length === 1) return exact[0]!.record;
  if (exact.length > 1) return null;

  const ranked = candidates
    .map(({ record, tabs: candidateTabs }) => ({ record, score: similarity(current, candidateTabs) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best.score < 0.88) return null;
  if (runnerUp && best.score - runnerUp.score < 0.12) return null;
  return best.record;
}
