import type { StoredTab } from '@/types/workspace';

export interface CurrentTabSnapshot {
  id?: number;
  title?: string;
  url?: string;
  favIconUrl?: string;
  index: number;
  pinned?: boolean;
}

export interface AddedTabChange {
  kind: 'added';
  title: string;
  url: string;
  favIconUrl?: string;
  position: number;
  pinned: boolean;
  tabId?: number;
}

export interface RemovedTabChange extends StoredTab {
  kind: 'removed';
}

export interface UpdatedTabChange extends Omit<AddedTabChange, 'kind'> {
  kind: 'updated';
  previous: StoredTab;
}

export type TabChange = AddedTabChange | RemovedTabChange | UpdatedTabChange;
export type TabChangeKind = TabChange['kind'];

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid']);

function currentToStored(tab: CurrentTabSnapshot): StoredTab {
  return {
    title: tab.title || '未命名标签页',
    url: tab.url || 'about:blank',
    favIconUrl: tab.favIconUrl,
    position: tab.index,
    pinned: Boolean(tab.pinned),
  };
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url.replace(/#.*$/, '');
    parsed.hash = '';
    parsed.hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url.replace(/#.*$/, '').replace(/\/$/, '');
  }
}

function titleSimilarity(first: string, second: string): number {
  const a = first.toLocaleLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '');
  const b = second.toLocaleLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return longer.includes(shorter) ? shorter.length / longer.length : 0;
}

function siteParts(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const labels = host.split('.');
    const commonCompoundSuffixes = new Set(['co.uk', 'com.au', 'com.cn', 'co.jp']);
    const suffix = labels.slice(-2).join('.');
    return {
      host,
      site: commonCompoundSuffixes.has(suffix) ? labels.slice(-3).join('.') : suffix,
      path: parsed.pathname.replace(/\/+$/, '') || '/',
    };
  } catch {
    return null;
  }
}

function isHighConfidenceRedirect(saved: StoredTab, current: CurrentTabSnapshot): boolean {
  const before = siteParts(saved.url);
  const after = siteParts(current.url || 'about:blank');
  if (!before || !after || before.site !== after.site || before.host === after.host || before.path !== after.path) return false;
  return Math.abs(saved.position - current.index) <= 2 && titleSimilarity(saved.title, current.title || '') >= 0.9;
}

function hasSavedChanges(saved: StoredTab, current: StoredTab): boolean {
  const visibleTitle = (title: string) => title.replace(/\p{Cf}/gu, '').trim();
  return saved.url !== current.url || visibleTitle(saved.title) !== visibleTitle(current.title) || saved.pinned !== current.pinned;
}

export function calculateTabDiff(savedTabs: StoredTab[], currentTabs: CurrentTabSnapshot[]) {
  const saved = [...savedTabs].sort((a, b) => a.position - b.position);
  const current = [...currentTabs].sort((a, b) => a.index - b.index);
  const usedSaved = new Set<number>();
  const usedCurrent = new Set<number>();
  const updated: UpdatedTabChange[] = [];

  const match = (canMatch: (before: StoredTab, after: CurrentTabSnapshot) => boolean) => {
    current.forEach((after, currentIndex) => {
      if (usedCurrent.has(currentIndex)) return;
      const savedIndex = saved
        .map((before, index) => ({ before, index }))
        .filter(({ before, index }) => !usedSaved.has(index) && canMatch(before, after))
        .sort((a, b) => Math.abs(a.before.position - after.index) - Math.abs(b.before.position - after.index))[0]?.index;
      if (savedIndex == null) return;
      usedSaved.add(savedIndex);
      usedCurrent.add(currentIndex);
      const before = saved[savedIndex];
      if (!before) return;
      const next = currentToStored(after);
      if (hasSavedChanges(before, next)) updated.push({ kind: 'updated', ...next, tabId: after.id, previous: before });
    });
  };

  match((before, after) => before.url === (after.url || 'about:blank'));
  match((before, after) => normalizeUrl(before.url) === normalizeUrl(after.url || 'about:blank'));
  match(isHighConfidenceRedirect);

  const added: AddedTabChange[] = current.flatMap((tab, index) => usedCurrent.has(index)
    ? []
    : [{ kind: 'added' as const, ...currentToStored(tab), tabId: tab.id }]);
  const removed: RemovedTabChange[] = saved.flatMap((tab, index) => usedSaved.has(index)
    ? []
    : [{ kind: 'removed' as const, ...tab }]);

  updated.sort((a, b) => a.position - b.position);
  return { added, removed, updated };
}

export function getTabDomain(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.hostname.replace(/^www\./, '');
    if (parsed.protocol === 'about:') return url;
    return parsed.protocol.replace(':', '') || '未知来源';
  } catch {
    return '未知来源';
  }
}

export function getTabLocation(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return getTabDomain(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${getTabDomain(url)}${path === '/' ? '' : path}`;
  } catch {
    return getTabDomain(url);
  }
}
