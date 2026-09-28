import type { WorkspaceLocalRecord } from '@/types/workspace';
import { isHighConfidenceRedirect, normalizeUrl } from './tabDiff';

export interface MatchableTab {
  title?: string;
  url?: string;
  pendingUrl?: string;
  pinned?: boolean;
  index: number;
}

interface TabIdentity {
  title: string;
  url: string;
  pinned: boolean;
  index: number;
}

export interface WorkspaceMatchScore {
  record: WorkspaceLocalRecord;
  score: number;
  matchedCount: number;
  eligible: boolean;
}

const HIGH_CONFIDENCE_SCORE = 0.88;
export const MIN_CANDIDATE_GAP = 0.12;

function currentTabs(tabs: MatchableTab[]): TabIdentity[] {
  return [...tabs]
    .sort((a, b) => a.index - b.index)
    .map((tab, index) => ({ title: tab.title || '', url: tab.url || tab.pendingUrl || 'about:blank', pinned: Boolean(tab.pinned), index }));
}

function savedTabs(record: WorkspaceLocalRecord): TabIdentity[] {
  return [...record.content.tabs]
    .sort((a, b) => a.position - b.position)
    .map(({ title, url, pinned }, index) => ({ title, url, pinned, index }));
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
    && left.every((tab, index) => normalizeUrl(tab.url) === normalizeUrl(right[index]!.url) && tab.pinned === right[index]!.pinned);
}

function matchedPairs(current: TabIdentity[], saved: TabIdentity[]) {
  const usedCurrent = new Set<number>();
  const usedSaved = new Set<number>();
  const pairs: Array<{ current: TabIdentity; saved: TabIdentity }> = [];
  const match = (canMatch: (currentTab: TabIdentity, savedTab: TabIdentity) => boolean) => {
    for (const savedTab of saved) {
      if (usedSaved.has(savedTab.index)) continue;
      const currentTab = current
        .filter((tab) => !usedCurrent.has(tab.index) && canMatch(tab, savedTab))
        .sort((a, b) => Math.abs(a.index - savedTab.index) - Math.abs(b.index - savedTab.index))[0];
      if (!currentTab) continue;
      usedCurrent.add(currentTab.index);
      usedSaved.add(savedTab.index);
      pairs.push({ current: currentTab, saved: savedTab });
    }
  };
  match((currentTab, savedTab) => normalizeUrl(currentTab.url) === normalizeUrl(savedTab.url));
  match((currentTab, savedTab) => isHighConfidenceRedirect(
    { title: savedTab.title, url: savedTab.url, position: savedTab.index, pinned: savedTab.pinned },
    { title: currentTab.title, url: currentTab.url, index: currentTab.index, pinned: currentTab.pinned },
  ));
  return pairs;
}

function similarity(current: TabIdentity[], saved: TabIdentity[]) {
  const largestSize = Math.max(current.length, saved.length);
  if (!largestSize) return { score: 0, matchedCount: 0, eligible: false };
  const pairs = matchedPairs(current, saved);
  const currentOrder = pairs.sort((a, b) => a.current.index - b.current.index).map(({ saved: tab }) => String(tab.index));
  const savedOrder = saved.map((tab) => String(tab.index));
  const urlCoverage = pairs.length / largestSize;
  const orderScore = orderedOverlap(currentOrder, savedOrder) / largestSize;
  const pinnedScore = pairs.filter(({ current: left, saved: right }) => left.pinned === right.pinned).length / largestSize;
  const countScore = Math.min(current.length, saved.length) / largestSize;
  const score = urlCoverage * 0.55 + orderScore * 0.2 + pinnedScore * 0.15 + countScore * 0.1;
  const smallWorkspaceMatch = largestSize <= 8
    && pairs.length >= 4
    && pairs.length >= current.length - 1
    && pairs.length >= saved.length - 1
    && Math.abs(current.length - saved.length) <= 1
    && orderScore >= 0.75
    && pinnedScore >= 0.75;
  return { score, matchedCount: pairs.length, eligible: score >= HIGH_CONFIDENCE_SCORE || smallWorkspaceMatch };
}

export function scoreWorkspaceMatch(tabs: MatchableTab[], record: WorkspaceLocalRecord): WorkspaceMatchScore {
  const current = currentTabs(tabs);
  const saved = savedTabs(record);
  if (!current.length) return { record, score: 0, matchedCount: 0, eligible: false };
  if (isExact(current, saved)) return { record, score: 1, matchedCount: saved.length, eligible: true };
  return { record, ...similarity(current, saved) };
}

export function matchWorkspace(
  tabs: MatchableTab[],
  records: WorkspaceLocalRecord[],
): WorkspaceLocalRecord | null {
  const current = currentTabs(tabs);
  if (!current.length) return null;

  const ranked = records
    .map((record) => scoreWorkspaceMatch(tabs, record))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best?.eligible) return null;
  if (runnerUp && best.score - runnerUp.score < MIN_CANDIDATE_GAP) return null;
  return best.record;
}
