import { browser } from 'wxt/browser';
import { LAZY_RECONCILIATION_ALARM, STORAGE_KEYS } from '@/lib/constants';
import { lazyRestoreRepository, type LazyRestoreEntry } from '@/lib/storage/lazyRestoreRepository';
import type { StoredTab } from '@/types/workspace';
import type { MatchableTab } from './workspaceMatcher';

const resolvingTabs = new Map<number, Promise<boolean>>();
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

function claimedLazyTabKey(tabId: number): string {
  return `claimedLazyTab:${tabId}`;
}

async function rememberClaim(tabId: number, lazyId: string): Promise<void> {
  await browser.storage.session.set({ [claimedLazyTabKey(tabId)]: lazyId });
}

async function claimedLazyId(tabId: number): Promise<string | null> {
  const key = claimedLazyTabKey(tabId);
  const result = await browser.storage.session.get(key);
  return (result[key] as string | undefined) ?? null;
}

async function forgetClaim(tabId: number): Promise<void> {
  await browser.storage.session.remove(claimedLazyTabKey(tabId));
}

async function liveLazyIds(): Promise<Set<string>> {
  const windows = await browser.windows.getAll({ populate: true });
  return new Set(windows
    .flatMap((window) => window.tabs ?? [])
    .map((tab) => lazyIdFromTab(tab))
    .filter((id): id is string => Boolean(id)));
}

export function lazyTabUrl(id: string): string {
  return `${browser.runtime.getURL('/lazy-tab.html')}?id=${encodeURIComponent(id)}`;
}

export function lazyIdFromUrl(url?: string): string | null {
  if (!url) return null;
  try {
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
  if (tab.position === activePosition || !tab.title.trim() || !isReliableFavicon(tab.favIconUrl)) return false;
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
    favIconUrl: tab.favIconUrl!,
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
  return {
    ...tab,
    title: entry.title,
    url: entry.originalUrl,
    pendingUrl: undefined,
    favIconUrl: entry.favIconUrl,
  };
}

export function resolveLogicalTabs<T extends MatchableTab & { favIconUrl?: string }>(tabs: T[]): Promise<T[]> {
  return Promise.all(tabs.map(resolveLogicalTab));
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

export function resolveLazyTab(tabId: number, lazyId?: string, windowId?: number): Promise<boolean> {
  const existing = resolvingTabs.get(tabId);
  if (existing) return existing;
  const task = (async () => {
    const tab = lazyId && windowId !== undefined ? undefined : await browser.tabs.get(tabId);
    const id = lazyId ?? lazyIdFromTab(tab!);
    if (!id) return false;
    const entry = await claimLazyTab(id, tabId, windowId ?? tab?.windowId);
    if (!entry) return false;
    await browser.tabs.update(tabId, { url: entry.originalUrl });
    return true;
  })().finally(() => {
    if (resolvingTabs.get(tabId) === task) resolvingTabs.delete(tabId);
  });
  resolvingTabs.set(tabId, task);
  return task;
}

export async function confirmLazyNavigation(tabId: number, url?: string): Promise<boolean> {
  if (!url || lazyIdFromUrl(url)) return false;
  const lazyId = await claimedLazyId(tabId);
  if (!lazyId) return false;
  await lazyRestoreRepository.remove(lazyId);
  await forgetClaim(tabId);
  return true;
}

export async function claimLazyTab(lazyId: string, tabId: number, windowId?: number): Promise<LazyRestoreEntry | null> {
  const entry = await lazyRestoreRepository.get(lazyId);
  if (!entry) return null;
  if (entry.tabId !== tabId || entry.windowId !== windowId) {
    const claimed = { ...entry, tabId, windowId };
    await lazyRestoreRepository.put(claimed);
    await rememberClaim(tabId, lazyId);
    return claimed;
  }
  await rememberClaim(tabId, lazyId);
  return entry;
}

export async function claimLazyTabFromBrowserTab(tab: MatchableTab & { id?: number; windowId?: number }): Promise<boolean> {
  const lazyId = lazyIdFromTab(tab);
  if (!lazyId || tab.id == null) return false;
  return Boolean(await claimLazyTab(lazyId, tab.id, tab.windowId));
}

export async function hydrateStartupLazyTab(tab: MatchableTab & { id?: number; windowId?: number }): Promise<boolean> {
  const lazyId = lazyIdFromTab(tab);
  if (!lazyId || tab.id == null) return false;
  const claimed = await claimLazyTab(lazyId, tab.id, tab.windowId);
  if (!claimed || !await isStartupLazyReconciliationActive() || hydratedStartupTabs.has(tab.id)) return false;
  hydratedStartupTabs.add(tab.id);
  await browser.tabs.reload(tab.id);
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
  return startupReconciliationStarting || Boolean(await getStartupReconciliation());
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
