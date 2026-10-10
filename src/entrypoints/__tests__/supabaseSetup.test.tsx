import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';

const storage = vi.hoisted(() => new Map<string, unknown>());
const requestPermission = vi.hoisted(() => vi.fn(async () => true));

// Entry points bootstrap themselves; render their roots explicitly in these tests.
vi.mock('react-dom/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-dom/client')>();
  return { ...original, default: { createRoot: () => ({ render: vi.fn() }) } };
});
vi.mock('wxt/browser', () => {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  return { browser: {
    runtime: { openOptionsPage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => undefined) },
    permissions: { request: requestPermission },
    storage: {
      local: {
        get: vi.fn(async (key: string | null) => key === null ? Object.fromEntries(storage) : { [key]: storage.get(key) }),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => storage.set(key, value)); }),
        remove: vi.fn(async (keys: string[]) => { keys.forEach((key) => storage.delete(key)); }),
      },
      onChanged: event(),
    },
    windows: { getCurrent: vi.fn(async () => ({ id: 1, tabs: [] })) },
    tabs: { onCreated: event(), onRemoved: event(), onUpdated: event(), onMoved: event() },
  } };
});
vi.mock('@/features/workspaces/workspaceService', () => ({
  resolveWorkspaceStateForWindow: vi.fn(async () => ({ status: 'unbound', record: null })),
}));
vi.mock('@/features/workspaces/lazyRestore', () => ({
  resolveLogicalTabs: vi.fn(async () => []), LazyTabResolutionError: class extends Error {},
}));
vi.mock('@/lib/storage/workspaceRepository', () => ({ workspaceRepository: { list: vi.fn(async () => []) } }));
vi.mock('@/lib/storage/syncLogRepository', () => ({ syncLogRepository: { list: vi.fn(async () => []) } }));
vi.mock('@/lib/supabase/authService', () => ({ authService: { session: vi.fn(async () => null) } }));
vi.mock('@/lib/sync/syncEngine', () => ({ syncEngine: {} }));

let root: ReturnType<typeof createRoot>;
let container: HTMLElement;
const config = { url: 'https://project.supabase.co', publishableKey: 'sb_publishable_example' };

beforeEach(() => {
  vi.clearAllMocks();
  storage.clear();
  vi.stubEnv('VITE_SUPABASE_URL', '');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
  const dom = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document: dom.document, window: dom.window, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event });
  Object.assign(window, { location: { search: '' }, open: vi.fn() });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  container = document.getElementById('root')!;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function renderPopup() {
  const { PopupRoot } = await import('../popup/main');
  await act(async () => root.render(<PopupRoot />));
}

async function renderOptions() {
  const { OptionsRoot } = await import('../options/main');
  await act(async () => root.render(<OptionsRoot />));
}

function button(text: string) {
  const result = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(result).toBeDefined();
  return result!;
}

async function click(text: string) {
  await act(async () => button(text).click());
}

async function enter(index: number, value: string) {
  const input = container.querySelectorAll('input')[index]!;
  // linkedom does not implement native input/change tracking. Invoke React's
  // attached change handler to exercise the real controlled form state.
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'))!;
  const props = (input as unknown as Record<string, { onChange: React.ChangeEventHandler<HTMLInputElement> }>)[propsKey]!;
  await act(async () => props.onChange({ target: { value } } as React.ChangeEvent<HTMLInputElement>));
}

async function switchTabs() {
  await act(async () => {
    window.dispatchEvent(new Event('blur'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('Supabase first setup', () => {
  it('shows a guide without config inputs and opens the standalone Options page', async () => {
    await renderPopup();
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('连接你的数据存储');
    await click('开始设置');
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce();
    expect(browser.permissions.request).not.toHaveBeenCalled();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    await click('查看开始使用教程 ↗');
    expect(window.open).toHaveBeenCalledWith('/开始使用.html', '_blank', 'noopener,noreferrer');
  });

  it('allows retrying if opening Options fails', async () => {
    vi.mocked(browser.runtime.openOptionsPage).mockRejectedValueOnce(new Error('unavailable'));
    await renderPopup();
    await click('开始设置');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法打开设置页');
    await click('开始设置');
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledTimes(2);
  });

  it('retains Options inputs across tab switches, tests and saves, then opens login and restores the Popup workspace', async () => {
    await renderOptions();
    expect(container.querySelector('.supabase-config.setup')).not.toBeNull();
    expect(button('保存并继续').disabled).toBe(true);
    await enter(0, config.url);
    await switchTabs();
    expect(container.querySelector('input')?.value).toBe(config.url);
    await enter(1, config.publishableKey);
    await switchTabs();
    const keyInput = container.querySelectorAll('input')[1]!;
    expect(keyInput.value).toBe(config.publishableKey);
    expect(keyInput.type).toBe('password');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="显示 Publishable Key"]')!.click());
    expect(keyInput.type).toBe('text');
    expect(keyInput.value).toBe(config.publishableKey);
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    await click('测试连接');
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: [`${config.url}/*`] });
    expect(fetch).toHaveBeenCalledWith(new URL(`${config.url}/auth/v1/settings`), expect.objectContaining({ headers: { apikey: config.publishableKey } }));
    expect(button('保存并继续').disabled).toBe(false);
    await click('保存并继续');
    expect(storage.get('supabaseConfig')).toEqual(config);
    expect(container.querySelector('.supabase-config')).toBeNull();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('登录');
    expect(container.querySelector('.auth-form')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await renderPopup();
    expect(container.textContent).toContain('当前窗口');
    expect(container.textContent).toContain('管理工作区');
    expect(container.textContent).not.toContain('开始设置');
    expect(container.querySelector('.supabase-config')).toBeNull();
  });

  it('keeps inputs and blocks saving when host permission is denied', async () => {
    requestPermission.mockResolvedValueOnce(false);
    await renderOptions();
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    await click('测试连接');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法连接到 Supabase');
    expect(button('保存并继续').disabled).toBe(true);
    expect(container.querySelector('input')?.value).toBe(config.url);
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
