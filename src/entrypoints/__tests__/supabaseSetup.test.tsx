import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authService } from '@/lib/supabase/authService';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import schema from '../../../supabase/schema.sql?raw';
import { browser } from 'wxt/browser';

const storage = vi.hoisted(() => new Map<string, unknown>());
const authEvents = vi.hoisted(() => ({ changed: () => {} }));
const requestPermission = vi.hoisted(() => vi.fn(async () => true));

// Entry points bootstrap themselves; render their roots explicitly in these tests.
vi.mock('react-dom/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-dom/client')>();
  return { ...original, default: { createRoot: () => ({ render: vi.fn() }) } };
});
vi.mock('wxt/browser', () => {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  return { browser: {
    runtime: { getURL: vi.fn((path: string) => `chrome-extension://fixture${path}`), openOptionsPage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => undefined) },
    permissions: { request: requestPermission },
    storage: {
      local: {
        get: vi.fn(async (key: string | string[] | null) => Object.fromEntries((key === null ? [...storage.keys()] : Array.isArray(key) ? key : [key]).map((item) => [item, storage.get(item)]))),
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
vi.mock('@/lib/supabase/authService', () => ({ authService: { session: vi.fn(async () => null), subscribe: vi.fn(async (changed: () => void) => { authEvents.changed = changed; return () => {}; }), signIn: vi.fn(), signOut: vi.fn(), requireSession: vi.fn() } }));
vi.mock('@/lib/sync/syncEngine', () => ({ syncEngine: { syncAll: vi.fn(async () => {}) } }));

let root: ReturnType<typeof createRoot>;
let container: HTMLElement;
const config = { url: 'https://project.supabase.co', publishableKey: 'sb_publishable_example' };

beforeEach(() => {
  vi.clearAllMocks();
  storage.clear();
  vi.mocked(authService.session).mockResolvedValue(null);
  vi.mocked(workspaceRepository.list).mockResolvedValue([]);
  vi.stubEnv('VITE_SUPABASE_URL', '');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
  const dom = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document: dom.document, window: dom.window, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, width: 780, height: 100 } as DOMRect);
  Object.assign(window, { location: { href: 'https://fixture.invalid/options.html', search: '' }, open: vi.fn(), history: {
    pushState: vi.fn((_state, _title, url) => { const next = new URL(String(url)); Object.assign(window.location, { href: next.href, search: next.search }); }),
    replaceState: vi.fn((_state, _title, url) => { const next = new URL(String(url)); Object.assign(window.location, { href: next.href, search: next.search }); }),
  } });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('getComputedStyle', () => ({ paddingLeft: '0', paddingRight: '0' }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  const drafts = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => drafts.get(key) ?? null, setItem: (key: string, value: string) => drafts.set(key, value), removeItem: (key: string) => drafts.delete(key) });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
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

async function verifyAndContinue() {
  await click('验证连接');
  if (!button('下一步').disabled) await click('下一步');
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

  it('starts guided, copies the exact SQL without advancing, and keeps fields across modes and back navigation', async () => {
    await renderOptions();
    expect(button('分步引导').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('input')).toBeNull();
    await click('项目已创建，下一步');
    await click('复制初始化 SQL');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(schema);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('初始化数据库');
    expect(storage.has('supabaseConfig')).toBe(false);
    await click('已运行 SQL，下一步');
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    await click('上一步');
    expect(container.querySelector('input')).toBeNull();
    await click('快速配置');
    expect(container.querySelectorAll('input')[0]!.value).toBe(config.url);
    expect(container.querySelectorAll('input')[1]!.value).toBe(config.publishableKey);
    await click('分步引导');
    await click('已运行 SQL，下一步');
    expect(container.querySelectorAll('input')[1]!.value).toBe(config.publishableKey);
    await verifyAndContinue();
    expect(storage.get('supabaseConfig')).toEqual(config);
    expect(container.querySelector('.auth-form')).not.toBeNull();
    expect(sessionStorage.getItem('windowstash-supabase-draft:v1')).toBeNull();
  });

  it('restores a draft after remounting but requires a fresh connection verification', async () => {
    await renderOptions();
    await click('项目已创建，下一步');
    await click('已运行 SQL，下一步');
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    await click('快速配置');
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    await verifyAndContinue();
    expect(storage.has('supabaseConfig')).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    await renderOptions();
    expect(button('快速配置').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('input')[1]!.value).toBe(config.publishableKey);
    expect(button('验证连接').disabled).toBe(false);
    expect(storage.has('supabaseConfig')).toBe(false);
    await click('分步引导');
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('连接 Supabase');
  });

  it('stays on the connection step when the server rejects credentials and retries without losing inputs', async () => {
    await renderOptions();
    await click('项目已创建，下一步');
    await click('已运行 SQL，下一步');
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    await verifyAndContinue();
    expect(container.querySelector('.config-footer [role="alert"]')?.textContent).toContain('无法连接');
    expect(storage.has('supabaseConfig')).toBe(false);
    expect(container.querySelectorAll('input')[1]!.value).toBe(config.publishableKey);
    await verifyAndContinue();
    expect(storage.get('supabaseConfig')).toEqual(config);
  });

  it('shares one dashboard entry beside the connection heading and keeps help with each input', async () => {
    await renderOptions();
    await click('项目已创建，下一步');
    await click('已运行 SQL，下一步');
    const tasks = container.querySelectorAll('.config-field-task');
    expect(tasks).toHaveLength(2);
    expect(container.querySelector('.config-connection-heading a')?.getAttribute('href')).toBe('https://supabase.com/dashboard');
    expect(container.querySelectorAll('.config-connection-heading a')).toHaveLength(1);
    expect(tasks[0]!.querySelector('a')).toBeNull();
    expect(tasks[0]!.querySelector('input')?.type).toBe('url');
    expect(tasks[1]!.querySelector('a')).toBeNull();
    expect(tasks[1]!.querySelector('input')?.type).toBe('password');
    expect(container.querySelector('.config-step-count')).toBeNull();
    const guidedActions = container.querySelector('.config-footer')!.textContent!.replace('上一步', '');
    await click('快速配置');
    expect(container.querySelectorAll('.config-steps button')).toHaveLength(2);
    expect(container.querySelector('.config-fields details')).toBeNull();
    expect(button('验证连接')).toBeDefined();
    expect(container.querySelector('.config-footer')!.textContent).toBe(guidedActions);
  });

  it('keeps verification feedback beside the action and locks inputs until validation and saving finish', async () => {
    await renderOptions();
    await click('快速配置');
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await verifyAndContinue();
    expect(container.querySelector('.config-connection-check [role="status"]')?.textContent).toContain('正在验证');
    expect(button('正在验证…').disabled).toBe(true);
    expect(container.querySelector('input')?.disabled).toBe(true);
    expect(button('分步引导').disabled).toBe(true);
    expect(storage.has('supabaseConfig')).toBe(false);
    await act(async () => resolve({ ok: true } as Response));
    expect(storage.has('supabaseConfig')).toBe(false);
    expect(button('下一步').disabled).toBe(false);
    await click('下一步');
    expect(storage.get('supabaseConfig')).toEqual(config);
    expect(container.querySelector('.auth-form')).not.toBeNull();
  });

  it('allows tutorial navigation immediately but requires saved verification before login', async () => {
    await renderOptions();
    let steps = container.querySelectorAll<HTMLButtonElement>('.config-steps button');
    expect(steps[1]!.disabled).toBe(false);
    expect(steps[2]!.disabled).toBe(false);
    expect(steps[3]!.disabled).toBe(true);
    await act(async () => steps[2]!.click());
    expect(container.querySelectorAll('input')).toHaveLength(2);
    await act(async () => steps[0]!.click());
    await click('项目已创建，下一步');
    await click('复制初始化 SQL');
    steps = container.querySelectorAll('.config-steps button');
    expect(steps[0]!.dataset.state).toBe('complete');
    expect(steps[2]!.disabled).toBe(false);
    await click('已运行 SQL，下一步');
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.config-steps button')[0]!.click());
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('创建项目');
    act(() => root.unmount());
    root = createRoot(container);
    await renderOptions();
    steps = container.querySelectorAll('.config-steps button');
    expect(steps[1]!.dataset.state).toBe('complete');
    expect(steps[2]!.disabled).toBe(false);
    expect(steps[3]!.disabled).toBe(true);
    expect(storage.has('supabaseConfig')).toBe(false);
  });

  it('links both modes to the packaged full guide in a new tab without changing the draft', async () => {
    await renderOptions();
    const guide = () => container.querySelector<HTMLAnchorElement>('.config-full-guide')!;
    expect(guide().getAttribute('href')).toBe('chrome-extension://fixture/开始使用.html');
    expect(guide().target).toBe('_blank');
    expect(guide().rel).toContain('noopener');
    await click('快速配置');
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    expect(guide().getAttribute('href')).toContain('/开始使用.html');
    expect(container.querySelectorAll('input')[1]!.value).toBe(config.publishableKey);
    expect(storage.has('supabaseConfig')).toBe(false);
  });

  it('places validation errors next to the affected field and clears them on editing', async () => {
    await renderOptions();
    await click('快速配置');
    await enter(0, 'invalid');
    await verifyAndContinue();
    const url = container.querySelector('input')!;
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(url.getAttribute('aria-describedby')!)?.textContent).toContain('URL');
    expect(fetch).not.toHaveBeenCalled();
    await enter(0, config.url);
    expect(url.getAttribute('aria-invalid')).toBe('false');
    await verifyAndContinue();
    const key = container.querySelectorAll('input')[1]!;
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(key.getAttribute('aria-describedby')!)?.textContent).toContain('Publishable Key');
    expect(storage.has('supabaseConfig')).toBe(false);
  });

  it('provides a manual SQL copy fallback when clipboard access fails', async () => {
    await renderOptions();
    await click('项目已创建，下一步');
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    await click('复制初始化 SQL');
    expect(container.textContent).toContain('无法复制');
    expect(container.querySelector('pre code')?.textContent).toBe(schema);
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
    await click('快速配置');
    expect(container.querySelector('.supabase-config.setup')).not.toBeNull();
    expect(button('验证连接').disabled).toBe(false);
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
    await verifyAndContinue();
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: [`${config.url}/*`] });
    expect(fetch).toHaveBeenCalledWith(new URL(`${config.url}/auth/v1/settings`), expect.objectContaining({ headers: { apikey: config.publishableKey } }));

    expect(storage.get('supabaseConfig')).toEqual(config);
    expect(container.querySelector('.supabase-config:not(.flow-login)')).toBeNull();
    expect(container.textContent).toContain('登录');
    expect(container.querySelector('.auth-form')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await renderPopup();
    expect(container.textContent).toContain('开始设置');
    expect(container.textContent).not.toContain('保存当前状态');
    expect(storage.get('supabaseConfig')).toEqual(config);
    expect(container.querySelector('.supabase-config:not(.flow-login)')).toBeNull();
  });

  it('keeps inputs and blocks saving when host permission is denied', async () => {
    requestPermission.mockResolvedValueOnce(false);
    await renderOptions();
    await click('快速配置');
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    await verifyAndContinue();
    expect(container.querySelector('.config-footer [role="alert"]')?.textContent).toContain('无法连接到 Supabase');
    expect(button('验证连接').disabled).toBe(false);
    expect(container.querySelector('input')?.value).toBe(config.url);
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe('manager authentication access', () => {
  const session = { user: { id: 'A', email: 'a@example.invalid' } } as Awaited<ReturnType<typeof authService.requireSession>>;
  it('checks session before reading cached workspaces and blocks direct URLs and back navigation', async () => {
    storage.set('supabaseConfig', config);
    let resolve!: (value: null) => void;
    vi.mocked(authService.session).mockImplementation(() => new Promise((done) => { resolve = done; }));
    await renderOptions();
    expect(container.textContent).toContain('正在检查登录状态');
    expect(workspaceRepository.list).not.toHaveBeenCalled();
    await act(async () => resolve(null));
    expect(container.querySelector('.dashboard')).toBeNull();
    expect(container.querySelector('.auth-form')).not.toBeNull();
    expect(container.querySelector('.login-config')).toBeNull();
    vi.mocked(authService.session).mockResolvedValue(null);
    await act(async () => window.dispatchEvent(new Event('pageshow')));
    expect(container.querySelector('.dashboard')).toBeNull();
    expect(workspaceRepository.list).not.toHaveBeenCalled();
  });
  it('enters the manager after login and leaves it immediately after logout', async () => {
    storage.set('supabaseConfig', config);
    await renderOptions();
    vi.mocked(authService.signIn).mockImplementation(async () => { vi.mocked(authService.session).mockResolvedValue(session); return session; });
    await enter(0, 'a@example.invalid');
    await enter(1, 'Password1');
    const form = container.querySelector('form')!;
    const key = Object.keys(form).find((item) => item.startsWith('__reactProps$'))!;
    await act(async () => (form as unknown as Record<string, { onSubmit: (event: { preventDefault: () => void }) => void }>)[key]!.onSubmit({ preventDefault() {} }));
    expect(container.querySelector('.dashboard')).not.toBeNull();
    expect(container.querySelector('.success-toast')?.textContent).toBe('登录成功');
    vi.mocked(authService.signOut).mockImplementation(async () => { vi.mocked(authService.session).mockResolvedValue(null); });
    await click('Aa@example.invalid');
    await click('退出登录');
    expect(container.querySelector('.dashboard')).toBeNull();
    expect(container.querySelector('.auth-form')).not.toBeNull();
    expect(container.querySelector('.success-toast')?.textContent).toBe('已退出登录');
    expect(storage.get('supabaseConfig')).toEqual(config);
  });
  it('returns to login on session expiration and external account changes', async () => {
    storage.set('supabaseConfig', config);
    vi.mocked(authService.session).mockResolvedValue(session);
    await renderOptions();
    expect(container.querySelector('.dashboard')).not.toBeNull();
    vi.mocked(authService.session).mockResolvedValue(null);
    await act(async () => authEvents.changed());
    expect(container.querySelector('.dashboard')).toBeNull();
    expect(container.querySelector('.auth-form')).not.toBeNull();
  });
  it('edits retained configuration, requires a fresh connection test and stays on login after switching projects', async () => {
    storage.set('supabaseConfig', config);
    storage.set('workspaces', { pending: 'preserved' });
    await renderOptions();
    await click('上一步');
    expect(container.querySelector('.auth-form')).toBeNull();
    expect(container.querySelectorAll('input')[0]!.value).toBe(config.url);
    expect(button('快速配置').getAttribute('aria-pressed')).toBe('true');
    expect(fetch).not.toHaveBeenCalled();
    await enter(0, 'https://new-project.supabase.co');
    await enter(1, 'sb_publishable_new');
    await verifyAndContinue();
    expect(storage.get('supabaseConfig')).toEqual({ url: 'https://new-project.supabase.co', publishableKey: 'sb_publishable_new' });
    expect(storage.get('workspaces')).toEqual({ pending: 'preserved' });
    expect(container.querySelector('.dashboard')).toBeNull();
    expect(container.querySelector('.auth-form')).not.toBeNull();
  });
});


describe('exclusive setup and login stages', () => {
  it.each(['快速配置', '分步引导'])('returns from login to %s with the saved fields and blocks login after edits without touching saved data', async (mode) => {
    await renderOptions();
    await click(mode);
    if (mode === '分步引导') await act(async () => container.querySelectorAll<HTMLButtonElement>('.config-steps button')[2]!.click());
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    await verifyAndContinue();
    expect(container.querySelector('.auth-form')).not.toBeNull();
    expect(container.querySelector('.supabase-config:not(.flow-login)')).toBeNull();
    expect(container.querySelectorAll('.config-site-header')).toHaveLength(1);
    expect(container.querySelector('.flow-login .config-modes')).not.toBeNull();
    expect(container.querySelector('.flow-footer .button-primary')?.getAttribute('form')).toBe(container.querySelector('.auth-form')?.id);
    expect(container.querySelector('.authorization-login-title')).toBeNull();
    expect(container.querySelector('.login-config')).toBeNull();
    await click('上一步');
    expect(container.querySelector('.auth-form')).toBeNull();
    expect(container.querySelector('.dashboard')).toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(2);
    expect(container.querySelectorAll('input')[0]!.value).toBe(config.url);
    expect(container.querySelectorAll('input')[1]!.value).toBe(config.publishableKey);
    expect(button(mode).getAttribute('aria-pressed')).toBe('true');
    await enter(0, 'https://unsaved.supabase.co');
    expect(button('下一步').disabled).toBe(true);
    expect(button('注册 / 登录').disabled).toBe(true);
    expect(container.querySelector('.auth-form')).toBeNull();
    expect([...container.querySelectorAll('button')].some((item) => item.textContent === '取消')).toBe(false);
    expect(storage.get('supabaseConfig')).toEqual(config);
  });

  it('freely switches quick configuration and login with saved configuration and keeps unsaved fields', async () => {
    storage.set('supabaseConfig', config);
    await renderOptions();
    await click('快速配置');
    expect(container.querySelectorAll('.config-steps button')).toHaveLength(2);
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.config-steps button')[0]!.click());
    await enter(0, 'https://unsaved.supabase.co');
    expect(button('注册 / 登录').disabled).toBe(true);
    expect(button('下一步').disabled).toBe(true);
    await click('验证连接');
    await click('注册 / 登录');
    expect(container.querySelector('.auth-form')).not.toBeNull();
    expect(button('快速配置').getAttribute('aria-pressed')).toBe('true');
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.config-steps button')[0]!.click());
    expect(container.querySelectorAll('input')[0]!.value).toBe('https://unsaved.supabase.co');
    expect(storage.get('supabaseConfig')).toEqual({ ...config, url: 'https://unsaved.supabase.co' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['快速配置', '分步引导'])('keeps %s selected across configuration/login switches despite an older draft mode', async (mode) => {
    storage.set('supabaseConfig', config);
    await renderOptions();
    await click(mode === '快速配置' ? '分步引导' : '快速配置');
    await click('上一步');
    await click('注册 / 登录');
    await click(mode);
    for (let count = 0; count < 3; count++) {
      await act(async () => container.querySelectorAll<HTMLButtonElement>('.config-steps button')[mode === '快速配置' ? 0 : 2]!.click());
      expect(button(mode).getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelectorAll('input')[0]!.value).toBe(config.url);
      await click('注册 / 登录');
      expect(button(mode).getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelectorAll('.config-steps button')).toHaveLength(mode === '快速配置' ? 2 : 4);
    }
    expect(storage.get('supabaseConfig')).toEqual(config);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['快速配置', '分步引导'])('retains successful verification in %s and invalidates it on either credential edit', async (mode) => {
    await renderOptions();
    await click(mode);
    if (mode === '分步引导') await act(async () => container.querySelectorAll<HTMLButtonElement>('.config-steps button')[2]!.click());
    await enter(0, config.url);
    await enter(1, config.publishableKey);
    expect(button('下一步').disabled).toBe(true);
    await click('验证连接');
    expect(button('验证成功').disabled).toBe(true);
    expect(container.querySelector('.success-toast')?.textContent).toBe('Supabase 验证成功');
    expect(storage.has('supabaseConfig')).toBe(false);
    act(() => root.unmount()); root = createRoot(container);
    await renderOptions();
    expect(button('验证成功').disabled).toBe(true);
    await click('下一步');
    await click('上一步');
    expect(button('验证成功').disabled).toBe(true);
    await click('注册 / 登录');
    await click('上一步');
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const index of [0, 1]) {
      await enter(index, index === 0 ? 'https://new.supabase.co' : 'sb_publishable_new');
      expect(button('下一步').disabled).toBe(true);
      expect(button('注册 / 登录').disabled).toBe(true);
      if (index === 0) {
        await enter(0, config.url);
        expect(button('下一步').disabled).toBe(true);
      }
      await click('验证连接');
      expect(button('下一步').disabled).toBe(false);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(storage.get('supabaseConfig')).toEqual(config);
  });

  it('restores the configuration stage on refresh and switches content on back without stacking forms', async () => {
    storage.set('supabaseConfig', config);
    await renderOptions();
    await click('上一步');
    const editingURL = window.location.href;
    expect(window.location.search).toContain('view=config');
    act(() => root.unmount()); root = createRoot(container);
    await renderOptions();
    expect(container.querySelector('.supabase-config:not(.flow-login)')).not.toBeNull();
    expect(container.querySelector('.auth-form')).toBeNull();
    Object.assign(window.location, { href: 'https://fixture.invalid/options.html', search: '' });
    await act(async () => window.dispatchEvent(new Event('popstate')));
    expect(container.querySelector('.auth-form')).not.toBeNull();
    expect(container.querySelector('.supabase-config:not(.flow-login)')).toBeNull();
    Object.assign(window.location, { href: editingURL, search: new URL(editingURL).search });
    await act(async () => window.dispatchEvent(new Event('popstate')));
    expect(container.querySelector('.auth-form')).toBeNull();
    expect(container.querySelector('.supabase-config:not(.flow-login)')).not.toBeNull();
    expect(storage.get('supabaseConfig')).toEqual(config);
  });
});

it('shows retained unowned legacy data and leaves it untouched when recovery is cancelled', async () => {
  storage.set('supabaseConfig', config);
  storage.set('workspaces', { legacy: { content: { id: 'old-private-workspace', name: 'Private old data' } } });
  const session = { user: { id: 'A', email: 'a@example.invalid' } } as Awaited<ReturnType<typeof authService.requireSession>>;
  vi.mocked(authService.session).mockResolvedValue(session);
  window.confirm = vi.fn(() => false);
  await renderOptions();
  expect(container.textContent).toContain('旧版数据仍保留：1 个工作区');
  expect(container.textContent).not.toContain('Private old data');
  await click('恢复旧版数据');
  expect(window.confirm).toHaveBeenCalled();
  expect(storage.has('windowstash-data-migrated:v1')).toBe(false);
  expect(storage.get('workspaces')).toEqual({ legacy: { content: { id: 'old-private-workspace', name: 'Private old data' } } });
});

it('shows login instead of saving after logout and restores the popup only after relogin', async () => {
  storage.set('supabaseConfig', config);
  const session = { user: { id: 'A' } } as Awaited<ReturnType<typeof authService.session>>;
  vi.mocked(authService.session).mockResolvedValue(session);
  await renderPopup();
  expect(container.textContent).toContain('保存当前状态');
  vi.mocked(authService.session).mockResolvedValue(null);
  await act(async () => authEvents.changed());
  expect(container.textContent).toContain('开始设置');
  expect(container.textContent).not.toContain('保存当前状态');
  expect(container.textContent).not.toContain('关联已有工作区');
  await click('开始设置');
  expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce();
  vi.mocked(authService.session).mockResolvedValue(session);
  await act(async () => authEvents.changed());
  expect(container.textContent).toContain('保存当前状态');
});
it('does not expose saving while identity is pending or when a pre-logout session resolves late', async () => {
  storage.set('supabaseConfig', config);
  let finish!: (value: Awaited<ReturnType<typeof authService.session>>) => void;
  vi.mocked(authService.session).mockImplementationOnce(() => new Promise((done) => { finish = done; }));
  await renderPopup();
  expect(container.textContent).toContain('正在确认登录状态');
  expect(container.textContent).not.toContain('保存当前状态');
  vi.mocked(authService.session).mockResolvedValue(null);
  await act(async () => authEvents.changed());
  expect(container.textContent).toContain('开始设置');
  await act(async () => finish({ user: { id: 'A' } } as Awaited<ReturnType<typeof authService.session>>));
  expect(container.textContent).toContain('开始设置');
  expect(container.textContent).not.toContain('保存当前状态');
});
it('reacts to logout storage events even when the SDK does not emit an auth event', async () => {
  storage.set('supabaseConfig', config);
  vi.mocked(authService.session).mockResolvedValue({ user: { id: 'A' } } as Awaited<ReturnType<typeof authService.session>>);
  await renderPopup();
  const changed = vi.mocked(browser.storage.onChanged.addListener).mock.calls[0]![0];
  vi.mocked(authService.session).mockResolvedValue(null);
  await act(async () => changed({ 'windowstash-data-owner:v1': { oldValue: 'A', newValue: 'signed-out' } }, 'local'));
  expect(container.textContent).toContain('开始设置');
  expect(container.textContent).not.toContain('保存当前状态');
});
