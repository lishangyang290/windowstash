import { expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import template from '@/entrypoints/lazy-tab/index.html?raw';
import { renderLazyRecovery } from '@/entrypoints/lazy-tab/recovery';
import { execFileSync } from 'node:child_process';
import { createLazyTabPage, dataLazyId, LAZY_DATA_PREFIX } from '../lazyTabPage';

const root = 'chrome-extension://fixture/';
it('preserves the title and existing favicon with escaped HTML and no page scripts', () => {
  const url = createLazyTabPage('id & 中文', root, { title: '<script>"&测试', favIconUrl: 'https://example.test/icon.png' });
  const html = decodeURIComponent(url.slice(LAZY_DATA_PREFIX.length).split('#')[0]!);
  expect(html).toContain('<title>&lt;script&gt;&quot;&amp;测试</title>');
  expect(html).toContain('href="https://example.test/icon.png"');
  expect(html).not.toMatch(/<script|<iframe|http-equiv="refresh"/);
  expect(dataLazyId(url, root)).toBe('id & 中文');
  expect(dataLazyId(url, 'chrome-extension://other/')).toBeNull();
  expect(dataLazyId('data:text/html,test', root)).toBeNull();
});

it('uses the existing default favicon and rejects executable favicon URLs', () => {
  const html = decodeURIComponent(createLazyTabPage('safe', root, { title: 'Safe', favIconUrl: 'javascript:alert(2)' }).split('#')[0]!.slice(LAZY_DATA_PREFIX.length));
  expect(html).toContain('data:image/svg+xml');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('<a ');
});

it('embeds the existing fallback and escaped saved icon before the placeholder runtime starts', () => {
  const icon = 'https://example.test/icon.svg?a=1&b="quoted"';
  const url = createLazyTabPage('saved', root, { title: 'Saved', favIconUrl: icon, originalUrl: 'https://example.test/' });
  const { document } = parseHTML(decodeURIComponent(url.slice(LAZY_DATA_PREFIX.length).split('#')[0]!));
  const link = document.getElementById('lazy-tab-favicon')!;
  expect(link.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/);
  expect(decodeURIComponent(link.getAttribute('href')!.split(',')[1]!)).toContain('M7 3h12l6 6v20H7z');
  expect(link.getAttribute('data-saved-favicon')).toBe(icon);
  expect(link.hasAttribute('onerror')).toBe(false);
  expect(document.querySelector('main')!.textContent).toBe('');
});

it('keeps the original blank body and the exact light/dark styles', () => {
  const html = decodeURIComponent(createLazyTabPage('saved', root).split('#')[0]!.slice(LAZY_DATA_PREFIX.length));
  const { document } = parseHTML(html);
  const original = parseHTML(template).document;
  expect(document.body.textContent.trim()).toBe('');
  expect(document.querySelector('style')!.textContent).toBe(original.querySelector('style')!.textContent);
  expect(document.querySelector('main')!.outerHTML).toBe(original.querySelector('main')!.outerHTML);
  expect(document.querySelector('script, a, button')).toBeNull();
});

it('matches the v0.6.0 template and recovery DOM instead of inventing a new view', () => {
  const stable = execFileSync('git', ['show', 'v0.6.0:src/entrypoints/lazy-tab/index.html'], { encoding: 'utf8' });
  expect(template).toBe(stable);
  const originalUrl = 'https://example.test/a?title=long&b=2';
  const url = createLazyTabPage('saved', root, { title: 'A very long original website title', favIconUrl: '', originalUrl });
  const { document } = parseHTML(decodeURIComponent(url.slice(LAZY_DATA_PREFIX.length).split('#')[0]!));
  const previous = globalThis.document;
  Object.assign(globalThis, { document });
  try {
    const container = document.createElement('main');
    renderLazyRecovery(container as unknown as HTMLElement, { unavailable: false, originalUrl, onRetry: () => {}, onClose: () => {} });
    const generated = document.querySelector('template')!.content;
    expect(generated.querySelector('strong')!.outerHTML).toBe(container.querySelector('strong')!.outerHTML);
    expect(generated.querySelector('.original-site')!.outerHTML).toBe(container.querySelector('.original-site')!.outerHTML);
    expect(generated.querySelector('button')!.outerHTML).toBe(container.querySelector('button')!.outerHTML);
    expect(generated.querySelector('[data-status]')!.textContent).toBe('正在尝试跳转至原网页…');
    expect(generated.querySelectorAll('p')[1]!.textContent).toBe('若长时间未自动跳转，请手动点击上方链接或下方按钮。');
    expect(document.querySelector('main')!.textContent).toBe('');
    expect(document.querySelector('style')!.textContent).toBe(parseHTML(stable).document.querySelector('style')!.textContent);
    expect(document.querySelector('script')!.hasAttribute('src')).toBe(false);
    expect(generated.querySelector('a')!.hasAttribute('target')).toBe(false);
    expect(generated.querySelector('a')!.hasAttribute('onclick')).toBe(false);
  } finally { Object.assign(globalThis, { document: previous }); }
});
