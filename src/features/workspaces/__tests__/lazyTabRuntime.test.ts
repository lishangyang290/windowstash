import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createLazyTabPage, LAZY_DATA_PREFIX } from '../lazyTabPage';

afterEach(() => vi.useRealTimers());

function page(visibility = 'hidden', savedUrl?: string, favIconUrl = '') {
  vi.useFakeTimers();
  const originalUrl = 'https://example.test/original';
  const url = createLazyTabPage('saved', 'chrome-extension://fixture/', { title: 'Saved title', favIconUrl, originalUrl });
  const { document, window } = parseHTML(decodeURIComponent((savedUrl ?? url).slice(LAZY_DATA_PREFIX.length).split('#')[0]!));
  Object.defineProperty(document, 'visibilityState', { value: visibility, configurable: true });
  const current = new URL(savedUrl ?? url);
  const location = {
    get hash() { return current.hash; },
    set hash(_value: string) { throw new Error('Not allowed to navigate top frame to data URL'); },
  };
  const history = { replaceState: vi.fn((_state: unknown, _title: string, hash: string) => { current.hash = hash; }) };
  const initialHash = location.hash;
  let iconProbe: ReturnType<typeof document.createElement> | undefined;
  const createElement = document.createElement.bind(document);
  const create = vi.spyOn(document, 'createElement').mockImplementation(tag => {
    const element = createElement(tag);
    if (tag === 'img') iconProbe = element;
    return element;
  });
  runInNewContext(document.querySelector('script')!.textContent, { document, location, history, setTimeout, clearTimeout, URLSearchParams });
  create.mockRestore();
  const marker = () => new URLSearchParams(location.hash.slice(1));
  const reply = (result: string, request = marker().get('windowstash-request')) => {
    const params = marker();
    params.set('windowstash-action', 'result');
    params.set('windowstash-result', result);
    params.set('windowstash-request', request!);
    current.hash = params.toString();
    window.dispatchEvent(new window.Event('hashchange'));
  };
  return { document, window, location, initialHash, marker, reply, originalUrl, history, current, iconProbe };
}

it('shows the inline fallback while a remote icon loads, then uses the saved icon without navigation', () => {
  const icon = 'https://example.test/icon.svg?a=1&b=2';
  const { document, window, iconProbe, location, initialHash } = page('hidden', undefined, icon);
  const link = document.getElementById('lazy-tab-favicon')!;
  expect(link.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/);
  expect(iconProbe!.getAttribute('src')).toBe(icon);
  iconProbe!.dispatchEvent(new window.Event('load'));
  expect(link.getAttribute('href')).toBe(icon);
  expect(location.hash).toBe(initialHash);
  expect(document.querySelector('main')!.textContent).toBe('');
});

it.each(['https://example.test/broken.ico', 'data:image/png;base64,broken'])('retains the inline fallback when %s fails', icon => {
  const { document, window, iconProbe, location, initialHash } = page('hidden', undefined, icon);
  const link = document.getElementById('lazy-tab-favicon')!;
  const fallback = link.getAttribute('href');
  iconProbe!.dispatchEvent(new window.Event('error'));
  vi.advanceTimersByTime(3000);
  expect(link.getAttribute('href')).toBe(fallback);
  expect(fallback).toMatch(/^data:image\/svg\+xml,/);
  expect(location.hash).toBe(initialHash);
});

it('accepts saved data-image icons after successful decoding', () => {
  const icon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
  const { document, window, iconProbe } = page('hidden', undefined, icon);
  iconProbe!.dispatchEvent(new window.Event('load'));
  expect(document.getElementById('lazy-tab-favicon')!.getAttribute('href')).toBe(icon);
});

it('restores the same icon from persisted data HTML after new document/worker sessions', () => {
  let savedUrl: string | undefined;
  const icon = 'https://example.test/saved.ico';
  for (let session = 0; session < 3; session++) {
    const { document, window, iconProbe, current } = page('hidden', savedUrl, icon);
    expect(document.getElementById('lazy-tab-favicon')!.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/);
    iconProbe!.dispatchEvent(new window.Event('load'));
    expect(document.getElementById('lazy-tab-favicon')!.getAttribute('href')).toBe(icon);
    savedUrl = current.href;
  }
});

it('loads no extra image when no usable saved icon exists', () => {
  const { document, iconProbe } = page('hidden', undefined, 'javascript:alert(1)');
  expect(iconProbe).toBeUndefined();
  expect(document.getElementById('lazy-tab-favicon')!.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/);
});

it('requests recovery on active reloads without navigating to a data URL or needing visibilitychange', () => {
  let savedUrl: string | undefined;
  for (let refresh = 0; refresh < 3; refresh++) {
    const { current, marker, history, document } = page('visible', savedUrl);
    expect(marker().get('windowstash-action')).toBe('restore');
    expect(marker().get('windowstash-lazy')).toBe('saved');
    expect(marker().get('extension')).toBe('chrome-extension://fixture/');
    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(document.querySelector('main')!.textContent).toBe('');
    savedUrl = current.href;
  }
});

it('keeps an unclicked inactive tab blank and never loads the website', () => {
  const { document, location, initialHash } = page();
  vi.advanceTimersByTime(3000);
  expect(location.hash).toBe(initialHash);
  expect(document.querySelector('main')!.textContent).toBe('');
});

it('requests existing background restoration when the page becomes visible', () => {
  const { document, window, marker } = page();
  Object.defineProperty(document, 'visibilityState', { value: 'visible' });
  document.dispatchEvent(new window.Event('visibilitychange'));
  expect(marker().get('windowstash-action')).toBe('restore');
  expect(document.querySelector('main')!.textContent).toBe('');
});

it('restores the original fallback layout and button retry after two seconds', () => {
  const { document, marker, originalUrl } = page('visible');
  expect(marker().get('windowstash-action')).toBe('restore');
  const firstRequest = marker().get('windowstash-request');
  vi.advanceTimersByTime(1999);
  expect(document.querySelector('main')!.textContent).toBe('');
  vi.advanceTimersByTime(1);
  const recovery = document.querySelector('main')!;
  expect(Array.from(recovery.children, child => child.tagName)).toEqual(['STRONG', 'DIV', 'DIV', 'BUTTON']);
  expect(recovery.querySelector('.recovery-message')!.querySelectorAll('p')).toHaveLength(2);
  expect(recovery.querySelector('strong')!.textContent).toBe('WindowStash');
  expect(recovery.querySelector('.original-site a')!.getAttribute('href')).toBe(originalUrl);
  expect(recovery.querySelector('p')!.textContent).toBe('正在尝试跳转至原网页…');
  const button = recovery.querySelector('button')!;
  expect(button.textContent).toBe('重新加载原页面');
  button.click();
  expect(marker().get('windowstash-action')).toBe('restore');
  expect(marker().get('windowstash-request')).not.toBe(firstRequest);
  vi.advanceTimersByTime(2000);
  expect(recovery.textContent).toContain('恢复请求尚未完成');
});

it('shows a clear background failure and retains the direct same-tab URL link', () => {
  const { document, reply, originalUrl } = page('visible');
  reply('failed');
  const recovery = document.querySelector('main')!;
  expect(recovery.textContent).toContain('恢复失败，请重试或点击上方链接。');
  expect(recovery.querySelector('a')!.getAttribute('href')).toBe(originalUrl);
  expect(recovery.querySelector('a')!.hasAttribute('target')).toBe(false);
  vi.advanceTimersByTime(3000);
  expect(recovery.textContent).toContain('恢复失败');
});

it('keeps the original missing-record state and routes the close button to the current tab', () => {
  const { document, reply, marker } = page('visible');
  reply('missing');
  const recovery = document.querySelector('main')!;
  expect(recovery.textContent).toContain('无法恢复此标签页');
  expect(recovery.textContent).not.toContain('正在尝试跳转');
  expect(recovery.querySelector('a')).toBeNull();
  const button = recovery.querySelector('button')!;
  expect(button.textContent).toBe('关闭此标签页');
  button.click();
  expect(marker().get('windowstash-action')).toBe('close');
});

it('ignores stale failure results from an earlier attempt', () => {
  const { document, reply } = page('visible');
  reply('failed', 'stale-request');
  expect(document.querySelector('main')!.textContent).toBe('');
});

it('keeps HTML from page metadata inert and never injects it into the script', () => {
  const title = '</title><script>throw 1</script>';
  const originalUrl = 'https://example.test/</script><script>throw 2</script>';
  const url = createLazyTabPage('saved', 'chrome-extension://fixture/', { title, favIconUrl: '', originalUrl });
  const { document } = parseHTML(decodeURIComponent(url.slice(LAZY_DATA_PREFIX.length).split('#')[0]!));
  expect(document.querySelectorAll('script')).toHaveLength(1);
  expect(document.title).toBe(title);
  expect(document.querySelector('script')!.textContent).not.toContain('throw');
});
