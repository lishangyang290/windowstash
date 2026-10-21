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
import { claimLazyTab, hasMissingLazyTabs, isStartupLazyReconciliationActive, lazyIdFromTab, lazyTabUrl, resolveLogicalTabs } from './lazyRestore';
import { lazyRestoreRepository } from '@/lib/storage/lazyRestoreRepository';
import type { MatchableTab } from './workspaceMatcher';

const MIN_SCORE = 0.82;
const MIN_GAP = 0.12;
const maintenanceTasks = new Map<string, Promise<number>>();
const ambiguousLogged = new Set<string>();
const updatedLogged = new Set<string>();
const refreshes = new Map<string, { requested: boolean; task: Promise<boolean> }>();
const restoringWindows = new Set<number>();

export function deferWindowAssociation(windowId: number): () => Promise<boolean> {
  restoringWindows.add(windowId);
  return async () => {
    restoringWindows.delete(windowId);
    return refreshBoundWindowAssociation(windowId);
  };
}

interface LiveWindow {
  windowId: number;
  tabs: MatchableTab[];
  lazyIds: string[];
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
  const savedIds = new Set(saved.flatMap(tab => tab.lazyId ? [tab.lazyId] : []));
  const identityMatches = !savedIds.size || window.lazyIds.every(id => savedIds.has(id));
  return {
    association,
    window,
    score: candidateScore,
    strongMatches,
    eligible: identityMatches && strongMatches > 0 && pairs.length >= Math.ceil(saved.length * 0.8) && candidateScore >= MIN_SCORE,
  };
}

async function logAssociation(action: string, association: PersistentWindowAssociation, message: object, scope: string): Promise<void> {
  const record = await workspaceRepository.get(association.workspaceId, scope);
  void syncLogRepository.add({
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
  restored = false,
): Promise<void> {
  if (!restored && restoringWindows.has(windowId)) return;
  const scope = requestedKey ?? await accountStorageKey('workspaces');
  const rawTabs = knownTabs ?? (await browser.windows.get(windowId, { populate: true })).tabs ?? [];
  if ((!restored && await isStartupLazyReconciliationActive()) || await hasMissingLazyTabs(workspaceId, windowId)) return;
  const tabs = await resolveLogicalTabs([...rawTabs].sort((a, b) => a.index - b.index));
  if (!tabs.length || scope !== await accountStorageKey('workspaces')) return;
  const saved = snapshot(tabs);
  const entries = await lazyRestoreRepository.list();
  [...rawTabs].sort((a, b) => a.index - b.index).forEach((tab, index) => {
    const id = lazyIdFromTab(tab) ?? entries.find(entry => 'id' in tab && entry.tabId === tab.id
      && entry.workspaceId === workspaceId && entry.originalUrl === saved.tabs[index]!.url)?.id;
    if (id) saved.tabs[index]!.lazyId = id;
  });
  const result = await windowAssociationRepository.upsert(workspaceId, saved, undefined, scope);
  if (result.created) await logAssociation('persistent-association-created', result.record, { tabCount: tabs.length }, scope).catch(() => undefined);
  else if (result.changed && !updatedLogged.has(result.record.associationId)) {
    updatedLogged.add(result.record.associationId);
    await logAssociation('persistent-association-updated', result.record, { tabCount: tabs.length }, scope).catch(() => undefined);
  }
}

export async function refreshBoundWindowAssociation(windowId: number): Promise<boolean> {
  // Handled by the final live snapshot; do not trigger association recovery.
  if (restoringWindows.has(windowId)) return true;
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
    if (window.id == null || restoringWindows.has(window.id)) continue;
    try {
      const tabs = await resolveLogicalTabs([...(window.tabs ?? [])].sort((a, b) => a.index - b.index));
      if (tabs.length) live.push({ windowId: window.id, tabs, lazyIds: (window.tabs ?? []).flatMap(tab => {
        const id = lazyIdFromTab(tab);
        return id ? [id] : [];
      }) });
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

// Only reconstruct an exact residual snapshot. Never infer identity from an old
// numeric window ID, and never fill gaps with URLs from a cloud workspace.
export async function recoverMissingLazyTabs(): Promise<number> {
  const scope = await accountStorageKey('workspaces');
  const [associations, entries, windows, records] = await Promise.all([
    windowAssociationRepository.list(), lazyRestoreRepository.list(),
    browser.windows.getAll({ populate: true }), workspaceRepository.list(),
  ]);
  const liveIds = new Set(windows.flatMap(window => window.tabs ?? []).map(lazyIdFromTab).filter(Boolean));
  const tabIds = new Set(windows.flatMap(window => window.tabs ?? []).map(tab => tab.id));
  const bindings = new Map(await Promise.all(windows.map(async window => [window.id, window.id == null ? null : await bindingRepository.get(window.id)] as const)));
  const candidates: Array<{ association: PersistentWindowAssociation; windowId: number; missing: typeof entries; fingerprint: string }> = [];
  const fingerprint = (tabs: MatchableTab[]) => JSON.stringify(tabs.map(tab => [tabUrl(tab), Boolean(tab.pinned)]));
  for (const association of associations) {
    if (!records.some(record => record.content.id === association.workspaceId)) continue;
    const saved = [...association.windowSnapshot.tabs].sort((a, b) => a.position - b.position);
    const hasIds = saved.some(tab => tab.lazyId);
    const pending = entries.filter(entry => entry.workspaceId === association.workspaceId && !liveIds.has(entry.id)
      && (!hasIds || saved.some(tab => tab.lazyId === entry.id)));
    // Legacy snapshots have no lazy IDs. Keep separate restore windows separate;
    // old retained batches must not collide with the current batch's positions.
    const batches = hasIds || !pending.length ? [pending] : [...new Set(pending.map(entry => entry.windowId))]
      .map(windowId => pending.filter(entry => entry.windowId === windowId));
    for (const missing of batches) {
    // A real tab with the old ID may be navigating; do not create a duplicate.
    if (missing.some(entry => entry.tabId != null && tabIds.has(entry.tabId))) continue;
    const removed = new Map<number, typeof entries[number]>();
    for (const entry of missing) {
      const index = saved.findIndex(tab => tab.lazyId ? tab.lazyId === entry.id
        : tab.position === entry.position && tab.url === entry.originalUrl && tab.pinned === entry.pinned);
      if (index >= 0 && saved[index]!.url === entry.originalUrl && !removed.has(index)) removed.set(index, entry);
    }
    if (removed.size !== missing.length) continue;
    const remaining = saved.filter((_, index) => !removed.has(index));
    for (const window of windows) {
      if (window.id == null || await bindingRepository.isSuppressed(window.id)) continue;
      if (!hasIds && pending.some(entry => entry.windowId === window.id)
        && missing[0]?.windowId !== window.id) continue;
      if ([...bindings].some(([id, workspaceId]) => id !== window.id && workspaceId === association.workspaceId)) continue;
      const binding = await bindingRepository.get(window.id);
      if (binding && binding !== association.workspaceId) continue;
      let logical;
      try { logical = await resolveLogicalTabs([...(window.tabs ?? [])].sort((a, b) => a.index - b.index)); }
      catch { continue; }
      const expected = remaining.map(tab => ({ ...tab, index: tab.position }));
      if (fingerprint(logical) !== fingerprint(expected)) continue;
      const distinct = new Set(remaining.map(tab => normalizeUrl(tab.url)).filter(isStrongUrl));
      const anchored = (window.tabs ?? []).some(tab => {
        const id = lazyIdFromTab(tab);
        return id && entries.some(entry => entry.id === id && entry.workspaceId === association.workspaceId);
      });
      if (missing.length && !anchored && distinct.size < 2) continue;
      candidates.push({ association, windowId: window.id, missing: [...removed].map(([index, entry]) => ({ ...entry, position: saved[index]!.position, pinned: saved[index]!.pinned })), fingerprint: fingerprint(window.tabs ?? []) });
    }
    }
  }
  let recovered = 0;
  for (const candidate of candidates) {
    if (!candidate.missing.length
      || candidates.filter(other => other.windowId === candidate.windowId).length !== 1
      || candidates.filter(other => other.association.workspaceId === candidate.association.workspaceId).length !== 1) continue;
    let expected = candidate.fingerprint;
    for (const entry of candidate.missing.sort((a, b) => a.position - b.position)) {
      if (scope !== await accountStorageKey('workspaces')) return recovered;
      const current = await browser.windows.get(candidate.windowId, { populate: true });
      if (fingerprint(current.tabs ?? []) !== expected || await bindingRepository.isSuppressed(candidate.windowId)) break;
      const binding = await bindingRepository.get(candidate.windowId);
      if (binding && binding !== candidate.association.workspaceId) break;
      const latest = await lazyRestoreRepository.get(entry.id);
      if (!latest || scope !== await accountStorageKey('workspaces')) break;
      const live = await browser.windows.getAll({ populate: true });
      if (live.some(window => window.tabs?.some(tab => lazyIdFromTab(tab) === entry.id))) break;
      const tab = await browser.tabs.create({ windowId: candidate.windowId, url: lazyTabUrl(entry.id, entry), index: entry.position, pinned: entry.pinned, active: false });
      if (tab.id == null) break;
      await claimLazyTab(entry.id, tab.id, candidate.windowId);
      recovered += 1;
      const next = [...(current.tabs ?? [])];
      next.splice(entry.position, 0, { ...tab, url: lazyTabUrl(entry.id, entry), pinned: entry.pinned });
      expected = fingerprint(next);
    }
  }
  return recovered;
}

export async function maintainWindowAssociations(): Promise<number> {
  const windows = await liveWindows();
  await Promise.all(windows.map(async (window) => {
    const workspaceId = await bindingRepository.get(window.windowId);
    if (workspaceId) await captureWindowAssociation(window.windowId, workspaceId, window.tabs);
  }));
  return restorePersistentWindowAssociations();
}
