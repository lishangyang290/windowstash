import { browser } from 'wxt/browser';
import { lazyRestoreRepository, type LazyRestoreEntry } from '@/lib/storage/lazyRestoreRepository';
import type { StoredTab } from '@/types/workspace';
import type { MatchableTab } from './workspaceMatcher';

const resolvingTabs = new Map<number, Promise<void>>();
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

export async function resolveLazyMatchableTab(tab: MatchableTab): Promise<MatchableTab> {
  const id = lazyIdFromTab(tab);
  if (!id) return tab;
  const entry = await lazyRestoreRepository.get(id);
  return entry ? { ...tab, title: entry.title, url: entry.originalUrl, pendingUrl: undefined } : tab;
}

export async function resolveLazyStoredTab(
  tab: MatchableTab & { favIconUrl?: string },
  position: number,
): Promise<StoredTab> {
  const id = lazyIdFromTab(tab);
  if (!id) {
    return {
      title: tab.title || '未命名标签页',
      url: tab.url || tab.pendingUrl || 'about:blank',
      favIconUrl: tab.favIconUrl,
      position,
      pinned: Boolean(tab.pinned),
    };
  }
  const entry = await lazyRestoreRepository.get(id);
  if (!entry) throw new Error('未加载标签页的恢复数据已丢失，请先打开该标签页后重试');
  return { title: entry.title, url: entry.originalUrl, favIconUrl: entry.favIconUrl, position, pinned: Boolean(tab.pinned) };
}

export function resolveLazyTab(tabId: number, lazyId?: string): Promise<void> {
  const existing = resolvingTabs.get(tabId);
  if (existing) return existing;
  const task = (async () => {
    const tab = await browser.tabs.get(tabId);
    const id = lazyId ?? lazyIdFromTab(tab);
    if (!id) return;
    const entry = await lazyRestoreRepository.get(id);
    if (!entry) return;
    await browser.tabs.update(tabId, { url: entry.originalUrl });
    await lazyRestoreRepository.remove(id);
  })().finally(() => {
    if (resolvingTabs.get(tabId) === task) resolvingTabs.delete(tabId);
  });
  resolvingTabs.set(tabId, task);
  return task;
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
