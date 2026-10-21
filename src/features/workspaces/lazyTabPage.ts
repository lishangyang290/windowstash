import type { LazyRestoreEntry } from '@/lib/storage/lazyRestoreRepository';
import template from '@/entrypoints/lazy-tab/index.html?raw';
import defaultFavicon from '../../../public/lazy-favicon.svg?raw';
import runtime from './lazyTabRuntime.js?raw';
import { usableFavicon } from './lazyTabAppearance';

export const LAZY_DATA_PREFIX = 'data:text/html;charset=utf-8,';
const fallbackFavicon = `data:image/svg+xml,${encodeURIComponent(defaultFavicon)}`;

export function createLazyTabPage(id: string, extensionRoot: string, entry?: Pick<LazyRestoreEntry, 'title' | 'favIconUrl'> & Partial<Pick<LazyRestoreEntry, 'originalUrl'>>): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const favicon = entry?.favIconUrl && usableFavicon(entry.favIconUrl) ? entry.favIconUrl : fallbackFavicon;
  let originalUrl = '';
  try {
    if (entry?.originalUrl && ['https:', 'http:'].includes(new URL(entry.originalUrl).protocol)) originalUrl = entry.originalUrl;
  } catch { /* Leave unreadable URLs inert. */ }
  const recovery = originalUrl ? `<template id="lazy-recovery-template"><strong>WindowStash</strong><div class="original-site"><a href="${escape(originalUrl)}">${escape(originalUrl)}</a></div><div class="recovery-message"><p data-status>正在尝试跳转至原网页…</p><p class="recovery-help">若长时间未自动跳转，请手动点击上方链接或下方按钮。</p></div><button type="button">重新加载原页面</button></template><template id="lazy-missing-template"><strong>WindowStash</strong><p>无法恢复此标签页</p><button type="button">关闭此标签页</button></template><script>${runtime}</script>` : '';
  const html = template
    .replace('</style>', '</style><style>.recovery-message{display:grid;gap:4px;margin:4px 0 8px}.recovery-message p{margin:0}.recovery-help{font-size:12px}button{cursor:pointer}</style>')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, () => recovery)
    .replace('<title>标签页</title>', () => `<title>${escape(entry?.title?.trim() || '标签页')}</title>`)
    .replace('href="/lazy-favicon.svg"', () => originalUrl
      ? `href="${escape(fallbackFavicon)}" data-saved-favicon="${escape(favicon)}"`
      : `href="${escape(favicon)}"`);
  return `${LAZY_DATA_PREFIX}${encodeURIComponent(html)}#${new URLSearchParams({ 'windowstash-lazy': id, extension: extensionRoot })}`;
}

export function dataLazyId(url: string, extensionRoot: string): string | null {
  if (!url.startsWith(LAZY_DATA_PREFIX)) return null;
  const marker = new URLSearchParams(new URL(url).hash.slice(1));
  return marker.get('extension') === extensionRoot ? marker.get('windowstash-lazy') || null : null;
}
