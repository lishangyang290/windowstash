import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import { applySetupResources, externalizeGuideScript, generateExtensionGuide } from './generate-extension-guide';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

describe('externalizeGuideScript', () => {
  it('moves the guide JavaScript into an external file', () => {
    const result = externalizeGuideScript('<main>教程</main><script>window.ready = true;</script>');

    expect(result.html).toBe('<main>教程</main><script src="./开始使用.js"></script>');
    expect(result.script).toBe('window.ready = true;\n');
  });

  it('keeps copy and navigation interactions working', async () => {
    const source = await readFile('public/开始使用.html', 'utf8');
    const guide = externalizeGuideScript(source);
    const { document } = parseHTML(guide.html);
    let clipboard = '';
    let copyFails = false;
    let observerCallback: IntersectionObserverCallback = () => undefined;
    const timers: Array<() => void> = [];
    const timeout = vi.fn((callback: () => void) => { timers.push(callback); return timers.length; });
    const clearTimer = vi.fn();
    document.execCommand = vi.fn(() => false);

    class IntersectionObserverMock {
      constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
      observe() { /* no-op */ }
    }

    vm.runInNewContext(guide.script, {
      document,
      navigator: { clipboard: { writeText: async (text: string) => {
        if (copyFails) throw new Error('Clipboard unavailable');
        clipboard = text;
      } } },
      IntersectionObserver: IntersectionObserverMock,
      setTimeout: timeout,
      clearTimeout: clearTimer,
    });

    const button = document.querySelector<HTMLButtonElement>('[data-copy="#schema-code"]')!;
    expect(button.closest('.code')?.tagName).toBe('DIV');
    expect(document.querySelector('.code summary')).toBeNull();
    expect(document.querySelectorAll('[data-copy="#schema-code"]')).toHaveLength(1);
    const toast = document.querySelector('.copy-toast')!;
    button.click();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(clipboard).toBe(document.querySelector('#schema-code')!.textContent);
    expect(button.textContent).toBe('复制代码');
    expect(toast.textContent).toBe('已复制到剪贴板');
    expect(toast.classList.contains('show')).toBe(true);
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 2000);

    button.click();
    button.click();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(document.querySelectorAll('.copy-toast')).toHaveLength(1);
    expect(clearTimer).toHaveBeenCalled();

    copyFails = true;
    button.click();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(toast.textContent).toBe('复制失败，请重试');
    expect(button.textContent).toBe('复制代码');

    timers.at(-1)!();
    expect(toast.classList.contains('show')).toBe(false);

    const navigation = document.querySelector('.progress-shell')!;
    const toggle = document.querySelector<HTMLButtonElement>('.nav-toggle')!;
    toggle.click();
    expect(navigation.classList.contains('open')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    document.querySelector<HTMLAnchorElement>('.progress a[href="#extension"]')!.click();
    expect(navigation.classList.contains('open')).toBe(false);

    const extension = document.querySelector('#extension')!;
    observerCallback([{ isIntersecting: true, target: extension } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(document.querySelector('.progress a[href="#extension"]')!.classList.contains('active')).toBe(true);
  });
});

it('keeps the standalone guide SQL and project settings aligned with shared setup resources', async () => {
  const source = await readFile('public/开始使用.html', 'utf8');
  const schema = await readFile('supabase/schema.sql', 'utf8');
  expect(applySetupResources(source, schema)).toBe(source);
  const stale = source.replace('create extension if not exists pgcrypto;', 'outdated SQL');
  expect(applySetupResources(stale, schema)).toBe(source);
});

it('ships the complete initialization and separate upgrade instructions through both guide entrances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windowstash-guide-'));
  try {
    const source = await readFile('public/开始使用.html', 'utf8');
    await generateExtensionGuide('public/开始使用.html', directory);
    const generated = await readFile(join(directory, '开始使用.html'), 'utf8');
    const standalonePath = join(directory, 'release-guide.html');
    execFileSync(process.execPath, ['scripts/generate-release-guide.mjs', directory, standalonePath]);
    const standalone = await readFile(standalonePath, 'utf8');
    const schema = await readFile('supabase/schema.sql', 'utf8');
    for (const html of [source, generated, standalone]) {
      const { document } = parseHTML(html);
      expect(document.querySelector('#schema-code')?.textContent).toBe(schema.trimEnd());
      const reminder = document.querySelector('#database-upgrade')!;
      expect(reminder.textContent).toContain('不要重复初始化');
      expect(reminder.textContent).toContain('不要删除原来的数据库');
      expect(reminder.textContent).toContain('旧版本升级');
      expect(document.querySelector('#database')?.textContent).toContain('schema.sql');
      expect(document.querySelector('a[href$=".sql"]')).toBeNull();
      expect(reminder.querySelector('a')?.getAttribute('href')).toBe('https://github.com/lishangyang290/windowstash/blob/main/README.md#旧版本升级说明');
      expect(document.querySelector('dialog')).toBeNull();
    }
    expect(generated).toBe(externalizeGuideScript(source).html);
    expect(externalizeGuideScript(standalone)).toEqual(externalizeGuideScript(source));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
