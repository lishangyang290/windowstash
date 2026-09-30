import type { LazyRestoreEntry } from '@/lib/storage/lazyRestoreRepository';

function usableFavicon(url: string): boolean {
  if (url.startsWith('data:image/')) return true;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function applyLazyTabAppearance(entry: Pick<LazyRestoreEntry, 'title' | 'favIconUrl'>, doc = document): HTMLLinkElement {
  doc.title = entry.title.trim() || '标签页';
  let link = doc.querySelector<HTMLLinkElement>('#lazy-tab-favicon');
  if (!link) {
    link = doc.createElement('link');
    link.id = 'lazy-tab-favicon';
    link.rel = 'icon';
    doc.head.append(link);
  }
  if (usableFavicon(entry.favIconUrl)) link.href = entry.favIconUrl;
  return link;
}
