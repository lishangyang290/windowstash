import { accountStorageKey } from '@/lib/storage/accountScope';
import { browser } from 'wxt/browser';
import { LAZY_RECONCILIATION_ALARM, STORAGE_KEYS } from '@/lib/constants';
import { lazyRestoreRepository, type LazyRestoreEntry } from '@/lib/storage/lazyRestoreRepository';
import type { StoredTab } from '@/types/workspace';
import type { MatchableTab } from './workspaceMatcher';
import { windowAssociationRepository } from '@/lib/storage/windowAssociationRepository';
import { createLazyTabPage, dataLazyId, LAZY_DATA_PREFIX } from './lazyTabPage';

const resolvingTabs = new Map<string, Promise<boolean>>();
const claimingTabs = new Map<string, Promise<LazyRestoreEntry | null>>();
const hydratedStartupTabs = new Set<number>();
const ORPHAN_GRACE_MS = 5 * 60 * 1000;
let startupReconciliationStarting = false;
let startupActivityRevision = 0;
export const STARTUP_RECONCILIATION_GRACE_MS = 60 * 1000;
export const STARTUP_RECONCILIATION_QUIET_MS = 5 * 1000;

interface StartupReconciliationState {
  startedAt: number;
  lastActivityAt: number;
  revision: number;
}

function claimedLazyTabKey(tabId: number): Promise<string> {
  return accountStorageKey(`claimedLazyTab:${tabId}`);
}

async function rememberClaim(tabId: number, lazyId: string, storageKey?: string): Promise<void> {
  await browser.storage.session.set({ [storageKey?.replace(/^lazyRestoreEntries/, `claimedLazyTab:${tabId}`) ?? await claimedLazyTabKey(tabId)]: lazyId });
}

async function claimedLazyId(tabId: number): Promise<string | null> {
  const key = await claimedLazyTabKey(tabId);
  const result = await browser.storage.session.get(key);
  return (result[key] as string | undefined) ?? null;
}

async function forgetClaim(tabId: number): Promise<void> {
  await browser.storage.session.remove(await claimedLazyTabKey(tabId));
}

async function liveLazyIds(): Promise<Set<string>> {
  const windows = await browser.windows.getAll({ populate: true });
  return new Set(windows
    .flatMap((window) => window.tabs ?? [])
    .map((tab) => lazyIdFromTab(tab))
    .filter((id): id is string => Boolean(id)));
}

export function lazyTabUrl(id: string, entry?: LazyRestoreEntry): string {
  return createLazyTabPage(id, browser.runtime.getURL('/'), entry);
}

export function lazyIdFromUrl(url?: string): string | null {
  if (!url) return null;
  try {
    if (url.startsWith(LAZY_DATA_PREFIX)) return dataLazyId(url, browser.runtime.getURL('/'));
    const parsed = new URL(url);
    const lazyPage = new URL(browser.runtime.getURL('/lazy-tab.html'));
    return parsed.origin === lazyPage.origin && parsed.pathname === lazyPage.pathname
      ? parsed.searchParams.get('id')
      : null;
  } catch {
    return null;
  }
}

export function lazyIdFromTab(tab: Pick<MatchableTab, 'url' | 'pendingUrl'>): string | null {
  return lazyIdFromUrl(tab.pendingUrl) ?? lazyIdFromUrl(tab.url);
}

export function isReliableFavicon(url?: string): url is string {
  if (!url) return false;
  if (url.startsWith('data:image/')) return true;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function canLazyRestore(tab: StoredTab, activePosition: number): boolean {
  if (tab.position === activePosition) return false;
  try {
    const protocol = new URL(tab.url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function createLazyEntry(workspaceId: string, tab: StoredTab): LazyRestoreEntry {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    originalUrl: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl ?? '',
    position: tab.position,
    pinned: tab.pinned,
    createdAt: new Date().toISOString(),
  };
}

export class LazyTabResolutionError extends Error {
  constructor() {
    super('部分标签页状态异常，请重新打开后再保存');
  }
}

export async function resolveLogicalTab<T extends MatchableTab & { favIconUrl?: string }>(tab: T): Promise<T> {
  const id = lazyIdFromTab(tab);
  if (!id) return tab;
  const entry = await lazyRestoreRepository.get(id);
  if (!entry) throw new LazyTabResolutionError();
  return logicalTabFromEntry(tab, entry);
}

function logicalTabFromEntry<T extends MatchableTab & { favIconUrl?: string }>(tab: T, entry: LazyRestoreEntry): T {
  return {
    ...tab,
    title: entry.title,
    url: entry.originalUrl,
    pendingUrl: undefined,
    favIconUrl: entry.favIconUrl,
  };
}

export async function resolveLogicalTabs<T extends MatchableTab & { favIconUrl?: string }>(tabs: T[], lazyStorageKey?: string): Promise<T[]> {
  if (!lazyStorageKey) return Promise.all(tabs.map(resolveLogicalTab));
  const ids = tabs.map(lazyIdFromTab);
  if (!ids.some(Boolean)) return tabs;
  // One request-local, account-scoped snapshot; the workspace resolver rechecks
  // live identity before exposing any result. No cross-popup data cache.
  const entries = new Map((await lazyRestoreRepository.list(lazyStorageKey)).map((entry) => [entry.id, entry]));
  return tabs.map((tab, index) => {
    const id = ids[index];
    if (!id) return tab;
    const entry = entries.get(id);
    if (!entry) throw new LazyTabResolutionError();
    return logicalTabFromEntry(tab, entry);
  });
}

export async function resolveLazyStoredTab(
  tab: MatchableTab & { favIconUrl?: string },
  position: number,
): Promise<StoredTab> {
  const logical = await resolveLogicalTab(tab);
  return {
    title: logical.title || '未命名标签页',
    url: logical.url || logical.pendingUrl || 'about:blank',
    favIconUrl: logical.favIconUrl,
    position,
    pinned: Boolean(logical.pinned),
  };
}

export async function resolveLazyTab(tabId: number, lazyId?: string, windowId?: number): Promise<boolean> {
  const scope = await accountStorageKey(STORAGE_KEYS.workspaces);
  const taskKey = `${scope}:${tabId}`;
  const existing = resolvingTabs.get(taskKey);
  if (existing) return existing;
  const task = (async () => {
    const tab = lazyId && windowId !== undefined ? undefined : await browser.tabs.get(tabId);
    const id = lazyId ?? lazyIdFromTab(tab!);
    if (!id) return false;
    const entry = await claimLazyTab(id, tabId, windowId ?? tab?.windowId);
    if (!entry || scope !== await accountStorageKey(STORAGE_KEYS.workspaces)) return false;
    await browser.tabs.update(tabId, { url: entry.originalUrl });
    return true;
  })().finally(() => {
    if (resolvingTabs.get(taskKey) === task) resolvingTabs.delete(taskKey);
  });
  resolvingTabs.set(taskKey, task);
  return task;
}

export async function confirmLazyNavigation(tabId: number, url?: string): Promise<boolean> {
  if (!url || !/^https?:\/\//.test(url)) return false;
  const lazyId = await claimedLazyId(tabId);
  if (!lazyId) return false;
  await lazyRestoreRepository.remove(lazyId);
  await forgetClaim(tabId);
  return true;
}

// A data page has no extension API. A same-document fragment change wakes the
// worker and lets manual retries use the existing registry/restore path.
export async function handleDataLazyAction(tabId: number, url?: string): Promise<void> {
  if (!url?.startsWith(LAZY_DATA_PREFIX) || !lazyIdFromUrl(url)) return;
  const parsed = new URL(url);
  const marker = new URLSearchParams(parsed.hash.slice(1));
  const action = marker.get('windowstash-action');
  if (!['restore', 'close'].includes(action ?? '') || !marker.get('windowstash-request')) return;
  const current = await browser.tabs.get(tabId);
  if (current.url !== url || (current.pendingUrl && current.pendingUrl !== url)) return;
  if (action === 'close') { await browser.tabs.remove(tabId); return; }
  let result = 'missing';
  try { if (await resolveLazyTab(tabId)) return; }
  catch { result = 'failed'; }
  const latest = await browser.tabs.get(tabId);
  if (latest.url !== url || (latest.pendingUrl && latest.pendingUrl !== url)) return;
  marker.set('windowstash-action', 'result');
  marker.set('windowstash-result', result);
  parsed.hash = marker.toString();
  await browser.tabs.update(tabId, { url: parsed.href });
}

export async function claimLazyTab(lazyId: string, tabId: number, windowId?: number): Promise<LazyRestoreEntry | null> {
  const scope = await accountStorageKey(STORAGE_KEYS.lazyRestoreEntries);
  const key = JSON.stringify([scope, lazyId, tabId, windowId]);
  const existing = claimingTabs.get(key);
  if (existing) return existing;
  const task = (async () => {
    const entry = await lazyRestoreRepository.get(lazyId, scope);
    if (!entry) return null;
    const claimed = entry.tabId === tabId && entry.windowId === windowId ? entry
      : await lazyRestoreRepository.bindTab(lazyId, tabId, windowId, scope);
    if (claimed) await rememberClaim(tabId, lazyId, scope);
    return claimed;
  })().finally(() => { if (claimingTabs.get(key) === task) claimingTabs.delete(key); });
  claimingTabs.set(key, task);
  return task;
}

export async function claimLazyTabFromBrowserTab(tab: MatchableTab & { id?: number; windowId?: number }): Promise<boolean> {
  const lazyId = lazyIdFromTab(tab);
  if (!lazyId || tab.id == null) return false;
  return Boolean(await claimLazyTab(lazyId, tab.id, tab.windowId));
}

export async function hydrateStartupLazyTab(tab: MatchableTab & { id?: number; windowId?: number; active?: boolean }): Promise<boolean> {
  const lazyId = lazyIdFromTab(tab);
  if (!lazyId || tab.id == null) return false;
  const claimed = await claimLazyTab(lazyId, tab.id, tab.windowId);
  if (tab.pendingUrl?.startsWith(LAZY_DATA_PREFIX) || tab.url?.startsWith(LAZY_DATA_PREFIX)) {
    if (claimed && tab.active && (!tab.pendingUrl || lazyIdFromUrl(tab.pendingUrl))) {
      return resolveLazyTab(tab.id);
    }
    return false;
  }
  if (!claimed || hydratedStartupTabs.has(tab.id)) return false;
  hydratedStartupTabs.add(tab.id);
  await browser.tabs.update(tab.id, { url: lazyTabUrl(lazyId, claimed) });
  return true;
}

export async function hydrateStartupLazyTabs(): Promise<void> {
  const windows = await browser.windows.getAll({ populate: true });
  for (const window of windows) {
    for (const tab of window.tabs ?? []) await hydrateStartupLazyTab(tab);
  }
}

export async function handleLazyTabReady(tabId: number, windowId: number | undefined, active: boolean, lazyId: string) {
  try {
    const entry = await claimLazyTab(lazyId, tabId, windowId);
    if (!entry) return 'missing' as const;
    if (!active) return 'waiting' as const;
    return await resolveLazyTab(tabId, lazyId, windowId) ? 'resolved' as const : 'missing' as const;
  } catch {
    return 'failed' as const;
  }
}

export function removeLazyTab(tabId: number): Promise<void> {
  return claimedLazyId(tabId).then(async (lazyId) => {
    lazyId ??= (await lazyRestoreRepository.list()).find(entry => entry.tabId === tabId && !entry.recoveryPending)?.id ?? null;
    if (!lazyId) return;
    await lazyRestoreRepository.remove(lazyId);
    await forgetClaim(tabId);
  });
}

export async function cleanupOrphanedLazyEntries(now = Date.now()): Promise<void> {
  const candidates = await lazyRestoreRepository.recordPresence(await liveLazyIds(), now);
  if (!candidates.length) return;
  await lazyRestoreRepository.removeConfirmedMissing(candidates, await liveLazyIds(), now, ORPHAN_GRACE_MS);
}

async function getStartupReconciliation(): Promise<StartupReconciliationState | null> {
  const result = await browser.storage.session.get(STORAGE_KEYS.lazyStartupReconciliation);
  return (result[STORAGE_KEYS.lazyStartupReconciliation] as StartupReconciliationState | undefined) ?? null;
}

async function scheduleStartupReconciliation(state: StartupReconciliationState): Promise<void> {
  await browser.alarms.create(LAZY_RECONCILIATION_ALARM, {
    when: Math.max(
      state.startedAt + STARTUP_RECONCILIATION_GRACE_MS,
      state.lastActivityAt + STARTUP_RECONCILIATION_QUIET_MS,
    ),
  });
}

export async function beginStartupLazyReconciliation(now = Date.now()): Promise<void> {
  startupReconciliationStarting = true;
  startupActivityRevision = 0;
  hydratedStartupTabs.clear();
  const state = { startedAt: now, lastActivityAt: now, revision: 0 };
  await browser.storage.session.remove(STORAGE_KEYS.lazyStartupReconciled);
  await browser.storage.session.set({ [STORAGE_KEYS.lazyStartupReconciliation]: state });
  await scheduleStartupReconciliation(state);
}

export async function noteStartupLazyActivity(now = Date.now()): Promise<void> {
  startupActivityRevision += 1;
  const state = await getStartupReconciliation();
  if (!state) return;
  const next = { ...state, lastActivityAt: now, revision: state.revision + 1 };
  await browser.storage.session.set({ [STORAGE_KEYS.lazyStartupReconciliation]: next });
  await scheduleStartupReconciliation(next);
}

export async function isStartupLazyReconciliationActive(): Promise<boolean> {
  return startupReconciliationStarting || Boolean(await getStartupReconciliation()) || !await isStartupLazyReconciliationComplete();
}

export async function hasMissingLazyTabs(workspaceId?: string, windowId?: number, inspectSnapshot = false): Promise<boolean> {
  const entries = await lazyRestoreRepository.list();
  if (!entries.length && !inspectSnapshot) return false;
  const windows = await browser.windows.getAll({ populate: true });
  const live = new Set(windows.flatMap(window => window.tabs ?? []).map(lazyIdFromTab));
  if (entries.some(entry => (!workspaceId || entry.workspaceId === workspaceId)
    && (windowId == null || entry.windowId === windowId)
    && (entry.recoveryPending || entry.tabId != null) && !live.has(entry.id))) return true;
  if (!inspectSnapshot || windowId == null) return false;
  const tabs = windows.find(window => window.id === windowId)?.tabs ?? [];
  if (!tabs.length) return false;
  const associations = await windowAssociationRepository.list();
  return associations.some(association => (!workspaceId || association.workspaceId === workspaceId)
    && (workspaceId || tabs.some(tab => association.windowSnapshot.tabs.some(saved => /^https?:/.test(saved.url) && saved.url === (tab.pendingUrl || tab.url))))
    && association.windowSnapshot.tabs.some(saved => saved.lazyId && !live.has(saved.lazyId)
      && (tabs.length < association.windowSnapshot.tabs.length || !tabs.some(tab => (tab.pendingUrl || tab.url) === saved.url))));
}

export async function initializeStartupLazyReconciliation(): Promise<void> {
  await hydrateStartupLazyTabs();
  await browser.storage.session.set({ [STORAGE_KEYS.lazyStartupReconciled]: true });
  await browser.storage.session.remove(STORAGE_KEYS.lazyStartupReconciliation);
  startupReconciliationStarting = false;
}

export async function isStartupLazyReconciliationComplete(): Promise<boolean> {
  const result = await browser.storage.session.get(STORAGE_KEYS.lazyStartupReconciled);
  return result[STORAGE_KEYS.lazyStartupReconciled] === true;
}

export async function finishStartupLazyReconciliation(now = Date.now()): Promise<boolean> {
  const state = await getStartupReconciliation();
  if (!state) return false;
  if (now < state.startedAt + STARTUP_RECONCILIATION_GRACE_MS
    || now < state.lastActivityAt + STARTUP_RECONCILIATION_QUIET_MS) {
    await scheduleStartupReconciliation(state);
    return false;
  }

  const localRevision = startupActivityRevision;
  const windows = await browser.windows.getAll({ populate: true });
  const liveIds = new Set<string>();
  for (const window of windows) {
    for (const tab of window.tabs ?? []) {
      const lazyId = lazyIdFromTab(tab);
      if (!lazyId || tab.id == null) continue;
      liveIds.add(lazyId);
      await claimLazyTab(lazyId, tab.id, tab.windowId ?? window.id);
    }
  }

  const latest = await getStartupReconciliation();
  if (!latest || latest.revision !== state.revision || startupActivityRevision !== localRevision) {
    if (latest) await scheduleStartupReconciliation(latest);
    return false;
  }

  await lazyRestoreRepository.recordPresence(liveIds, now);
  await browser.storage.session.set({ [STORAGE_KEYS.lazyStartupReconciled]: true });
  await browser.storage.session.remove(STORAGE_KEYS.lazyStartupReconciliation);
  startupReconciliationStarting = false;
  return true;
}
