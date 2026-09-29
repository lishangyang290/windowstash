import { browser } from 'wxt/browser';
import { lazyRestoreRepository, type LazyRestoreEntry } from '@/lib/storage/lazyRestoreRepository';
import type { StoredTab } from '@/types/workspace';
import type { MatchableTab } from './workspaceMatcher';

const resolvingTabs = new Map<number, Promise<boolean>>();
const ORPHAN_GRACE_MS = 5 * 60 * 1000;

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

export function resolveLazyTab(tabId: number, lazyId?: string): Promise<boolean> {
  const existing = resolvingTabs.get(tabId);
  if (existing) return existing;
  const task = (async () => {
    const id = lazyId ?? lazyIdFromTab(await browser.tabs.get(tabId));
    if (!id) return false;
    const entry = await lazyRestoreRepository.get(id);
    if (!entry) return false;
    if (entry.tabId !== tabId) await lazyRestoreRepository.put({ ...entry, tabId });
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
  await lazyRestoreRepository.removeByTabId(tabId);
  return true;
}

export async function handleLazyTabReady(tabId: number, active: boolean, lazyId: string) {
  if (!active) return 'waiting' as const;
  try {
    return await resolveLazyTab(tabId, lazyId) ? 'resolved' as const : 'missing' as const;
  } catch {
    return 'failed' as const;
  }
}

export function removeLazyTab(tabId: number): Promise<void> {
  return lazyRestoreRepository.removeByTabId(tabId);
}

export async function cleanupOrphanedLazyEntries(now = Date.now()): Promise<void> {
  const entries = await lazyRestoreRepository.list();
  if (!entries.length) return;
  const windows = await browser.windows.getAll({ populate: true });
  const liveIds = new Set(windows.flatMap((window) => window.tabs ?? []).map((tab) => lazyIdFromTab(tab)).filter(Boolean));
  await lazyRestoreRepository.removeMany(entries
    .filter((entry) => !liveIds.has(entry.id) && now - new Date(entry.createdAt).getTime() >= ORPHAN_GRACE_MS)
    .map((entry) => entry.id));
}
