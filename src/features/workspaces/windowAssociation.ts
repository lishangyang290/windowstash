import { accountStorageKey } from '@/lib/storage/accountScope';
import { browser } from 'wxt/browser';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import {
  windowAssociationRepository,
  type PersistentWindowAssociation,
  type WindowAssociationTab,
} from '@/lib/storage/windowAssociationRepository';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { normalizeUrl } from './tabDiff';
import { resolveLogicalTabs } from './lazyRestore';
import type { MatchableTab } from './workspaceMatcher';

const MIN_SCORE = 0.82;
const MIN_GAP = 0.12;
const maintenanceTasks = new Map<string, Promise<number>>();
const ambiguousLogged = new Set<string>();
const updatedLogged = new Set<string>();
const refreshes = new Map<string, { requested: boolean; task: Promise<boolean> }>();

interface LiveWindow {
  windowId: number;
  tabs: MatchableTab[];
}

interface Candidate {
  association: PersistentWindowAssociation;
  window: LiveWindow;
  score: number;
  strongMatches: number;
  eligible: boolean;
}

function tabUrl(tab: Pick<MatchableTab, 'url' | 'pendingUrl'>): string {
  return normalizeUrl(tab.pendingUrl || tab.url || 'about:blank');
}

function isStrongUrl(url: string): boolean {
  return !['about:blank', 'chrome://newtab', 'chrome://newtab/', 'chrome://new-tab-page/', 'edge://newtab/'].includes(url);
}

function snapshot(tabs: MatchableTab[], activeTabIndex = tabs.findIndex((tab) => 'active' in tab && tab.active)): PersistentWindowAssociation['windowSnapshot'] {
  return {
    tabs: [...tabs].sort((a, b) => a.index - b.index).map((tab, position) => ({
      url: tab.pendingUrl || tab.url || 'about:blank',
      pinned: Boolean(tab.pinned),
      position,
    })),
    activeTabIndex: Math.max(0, activeTabIndex),
  };
}

function occurrenceTokens(tabs: Array<Pick<WindowAssociationTab, 'url'>>): string[] {
  const counts = new Map<string, number>();
  return tabs.map((tab) => {
    const url = normalizeUrl(tab.url);
    const count = (counts.get(url) ?? 0) + 1;
    counts.set(url, count);
    return `${url}\u0000${count}`;
  });
}

function orderedOverlap(left: string[], right: string[]): number {
  const previous = new Array<number>(right.length + 1).fill(0);
  for (const value of left) {
    const next = [...previous];
    for (let index = 1; index <= right.length; index += 1) {
      next[index] = value === right[index - 1]
        ? (previous[index - 1] ?? 0) + 1
        : Math.max(previous[index] ?? 0, next[index - 1] ?? 0);
    }
    previous.splice(0, previous.length, ...next);
  }
  return previous[right.length] ?? 0;
}

function score(association: PersistentWindowAssociation, window: LiveWindow): Candidate {
  const saved = [...association.windowSnapshot.tabs].sort((a, b) => a.position - b.position);
  const current = [...window.tabs].sort((a, b) => a.index - b.index);
  const used = new Set<number>();
  const pairs: Array<{ saved: WindowAssociationTab; current: MatchableTab }> = [];
  for (const savedTab of saved) {
    const match = current
      .map((tab, index) => ({ tab, index }))
      .filter(({ tab, index }) => !used.has(index) && tabUrl(tab) === normalizeUrl(savedTab.url))
      .sort((a, b) => Math.abs(a.tab.index - savedTab.position) - Math.abs(b.tab.index - savedTab.position))[0];
    if (!match) continue;
    used.add(match.index);
    pairs.push({ saved: savedTab, current: match.tab });
  }

  const largest = Math.max(saved.length, current.length);
  const strongMatches = pairs.filter(({ saved: tab }) => isStrongUrl(normalizeUrl(tab.url))).length;
  const overlap = largest ? pairs.length / largest : 0;
  const order = largest ? orderedOverlap(
    occurrenceTokens(current.map((tab) => ({ url: tab.pendingUrl || tab.url || 'about:blank' }))),
    occurrenceTokens(saved),
  ) / largest : 0;
  const pinned = largest ? pairs.filter(({ saved: left, current: right }) => left.pinned === Boolean(right.pinned)).length / largest : 0;
  const count = largest ? Math.min(saved.length, current.length) / largest : 0;
  const candidateScore = overlap * 0.6 + order * 0.2 + pinned * 0.1 + count * 0.1;
  return {
    association,
    window,
    score: candidateScore,
    strongMatches,
    eligible: strongMatches > 0 && pairs.length >= Math.ceil(saved.length * 0.8) && candidateScore >= MIN_SCORE,
  };
}

async function logAssociation(action: string, association: PersistentWindowAssociation, message: object, scope: string): Promise<void> {
  const record = await workspaceRepository.get(association.workspaceId, scope);
  await syncLogRepository.add({
    workspaceId: association.workspaceId,
    workspaceName: record?.content.name ?? 'Unknown workspace',
    action,
    result: action.endsWith('failed') ? 'failed' : 'info',
    message: JSON.stringify(message),
  }, ...(scope === 'workspaces' ? [] : [scope.replace(/^workspaces/, 'syncLogs')]));
}

export async function captureWindowAssociation(
  windowId: number,
  workspaceId: string,
  knownTabs?: MatchableTab[],
  requestedKey?: string,
): Promise<void> {
  const scope = requestedKey ?? await accountStorageKey('workspaces');
  const rawTabs = knownTabs ?? (await browser.windows.get(windowId, { populate: true })).tabs ?? [];
  const tabs = await resolveLogicalTabs([...rawTabs].sort((a, b) => a.index - b.index));
  if (!tabs.length || scope !== await accountStorageKey('workspaces')) return;
  const result = await windowAssociationRepository.upsert(workspaceId, snapshot(tabs), undefined, scope);
  if (result.created) await logAssociation('persistent-association-created', result.record, { tabCount: tabs.length }, scope).catch(() => undefined);
  else if (result.changed && !updatedLogged.has(result.record.associationId)) {
    updatedLogged.add(result.record.associationId);
    await logAssociation('persistent-association-updated', result.record, { tabCount: tabs.length }, scope).catch(() => undefined);
  }
}

export async function refreshBoundWindowAssociation(windowId: number): Promise<boolean> {
  const scope = await accountStorageKey('workspaces');
  const taskKey = `${scope}:${windowId}`;
  const existing = refreshes.get(taskKey);
  if (existing) {
    existing.requested = true;
    return existing.task;
  }
  const state = { requested: true, task: Promise.resolve(false) };
  refreshes.set(taskKey, state);
  state.task = (async () => {
    let captured = false;
    while (state.requested) {
      state.requested = false;
      if (scope !== await accountStorageKey('workspaces')) break;
      const workspaceId = await bindingRepository.get(windowId);
      if (!workspaceId) continue;
      await captureWindowAssociation(windowId, workspaceId, undefined, scope);
      captured = true;
    }
    return captured;
  })().finally(() => { refreshes.delete(taskKey); });
  return state.task;
}

export async function bindWindow(
  windowId: number,
  workspaceId: string,
  knownTabs?: MatchableTab[],
  requestedKey?: string,
): Promise<void> {
  const scope = requestedKey ?? await accountStorageKey('workspaces');
  if (scope !== await accountStorageKey('workspaces')) return;
  await bindingRepository.set(windowId, workspaceId, ...(scope === 'workspaces' ? [] : [scope]));
  await captureWindowAssociation(windowId, workspaceId, knownTabs, scope).catch(() => undefined);
}

async function liveWindows(): Promise<LiveWindow[]> {
  const windows = await browser.windows.getAll({ populate: true });
  const live: LiveWindow[] = [];
  for (const window of windows) {
    if (window.id == null) continue;
    try {
      const tabs = await resolveLogicalTabs([...(window.tabs ?? [])].sort((a, b) => a.index - b.index));
      if (tabs.length) live.push({ windowId: window.id, tabs });
    } catch {
      // A lazy tab may still be hydrating. A later maintenance pass will retry.
    }
  }
  return live;
}

async function restore(scope: string): Promise<number> {
  const [associations, windows, workspaces] = await Promise.all([
    windowAssociationRepository.list(),
    liveWindows(),
    workspaceRepository.list(),
  ]);
  if (scope !== await accountStorageKey('workspaces')) return 0;
  const knownWorkspaceIds = new Set(workspaces.map((record) => record.content.id));
  const claimedWorkspaces = new Set<string>();
  const availableWindows: LiveWindow[] = [];
  for (const window of windows) {
    const binding = await bindingRepository.get(window.windowId);
    if (binding) claimedWorkspaces.add(binding);
    else if (!await bindingRepository.isSuppressed(window.windowId)) availableWindows.push(window);
  }

  const candidates = associations
    .filter((association) => knownWorkspaceIds.has(association.workspaceId) && !claimedWorkspaces.has(association.workspaceId))
    .flatMap((association) => availableWindows.map((window) => score(association, window)))
    .filter((candidate) => candidate.eligible);
  const restored: Candidate[] = [];
  for (const candidate of candidates) {
    const sameAssociation = candidates
      .filter((other) => other.association.associationId === candidate.association.associationId)
      .sort((a, b) => b.score - a.score);
    const sameWindow = candidates
      .filter((other) => other.window.windowId === candidate.window.windowId)
      .sort((a, b) => b.score - a.score);
    if (sameAssociation[0] !== candidate || sameWindow[0] !== candidate) continue;
    if ((sameAssociation[1] && candidate.score - sameAssociation[1].score < MIN_GAP)
      || (sameWindow[1] && candidate.score - sameWindow[1].score < MIN_GAP)) {
      if (!ambiguousLogged.has(candidate.association.associationId)) {
        ambiguousLogged.add(candidate.association.associationId);
        await logAssociation('persistent-association-ambiguous', candidate.association, {
          windowCount: availableWindows.length,
          candidateCount: candidates.length,
          tabCount: candidate.window.tabs.length,
        }, scope).catch(() => undefined);
      }
      continue;
    }
    restored.push(candidate);
  }

  for (const candidate of restored) {
    if (scope !== await accountStorageKey('workspaces')) return 0;
    ambiguousLogged.delete(candidate.association.associationId);
    await bindWindow(candidate.window.windowId, candidate.association.workspaceId, candidate.window.tabs, scope);
    await logAssociation('persistent-association-restored', candidate.association, {
      windowCount: windows.length,
      tabCount: candidate.window.tabs.length,
      candidateCount: candidates.length,
      score: Number(candidate.score.toFixed(3)),
    }, scope).catch(() => undefined);
  }
  return restored.length;
}

export async function restorePersistentWindowAssociations(): Promise<number> {
  const scope = await accountStorageKey('workspaces');
  const existing = maintenanceTasks.get(scope);
  if (existing) return existing;
  const task = restore(scope).catch(async (error) => {
    const associations = await windowAssociationRepository.list().catch(() => []);
    await Promise.all(associations.map((association) => logAssociation('persistent-association-failed', association, {
      reason: error instanceof Error ? error.message : 'unknown',
    }, scope).catch(() => undefined)));
    return 0;
  }).finally(() => { maintenanceTasks.delete(scope); });
  maintenanceTasks.set(scope, task);
  return task;
}

export async function maintainWindowAssociations(): Promise<number> {
  const windows = await liveWindows();
  await Promise.all(windows.map(async (window) => {
    const workspaceId = await bindingRepository.get(window.windowId);
    if (workspaceId) await captureWindowAssociation(window.windowId, workspaceId, window.tabs);
  }));
  return restorePersistentWindowAssociations();
}
