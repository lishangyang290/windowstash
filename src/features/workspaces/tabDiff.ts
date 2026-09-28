import type { StoredTab } from '@/types/workspace';

export interface CurrentTabSnapshot {
  id?: number;
  title?: string;
  url?: string;
  favIconUrl?: string;
  index: number;
}

export interface AddedTabChange {
  kind: 'added';
  title: string;
  url: string;
  favIconUrl?: string;
  position: number;
  tabId?: number;
}

export interface ClosedTabChange {
  kind: 'closed';
  title: string;
  url: string;
  favIconUrl?: string;
  position: number;
  pinned: boolean;
}

export type TabChange = AddedTabChange | ClosedTabChange;

export function calculateTabDiff(savedTabs: StoredTab[], currentTabs: CurrentTabSnapshot[]) {
  const savedByUrl = new Map<string, StoredTab[]>();
  const added: AddedTabChange[] = [];

  for (const tab of [...savedTabs].sort((a, b) => a.position - b.position)) {
    const tabs = savedByUrl.get(tab.url) ?? [];
    tabs.push(tab);
    savedByUrl.set(tab.url, tabs);
  }

  for (const tab of [...currentTabs].sort((a, b) => a.index - b.index)) {
    const url = tab.url || 'about:blank';
    const matches = savedByUrl.get(url);
    if (matches?.length) {
      matches.shift();
      continue;
    }
    added.push({
      kind: 'added',
      title: tab.title || '未命名标签页',
      url,
      favIconUrl: tab.favIconUrl,
      position: tab.index,
      tabId: tab.id,
    });
  }

  const closed: ClosedTabChange[] = [];
  for (const tabs of savedByUrl.values()) {
    for (const tab of tabs) closed.push({ kind: 'closed', ...tab });
  }
  closed.sort((a, b) => a.position - b.position);

  return { added, closed };
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
