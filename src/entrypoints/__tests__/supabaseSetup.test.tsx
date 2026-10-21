import React, { act } from 'react';
vi.mock('@/features/workspaces/quickSavePage', () => ({ registerQuickSavePage: vi.fn(async () => {}) }));
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authService } from '@/lib/supabase/authService';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import schema from '../../../supabase/schema.sql?raw';
import popupHtml from '../popup/index.html?raw';
import { browser } from 'wxt/browser';
import { deleteWorkspace, resolveWorkspaceStateForWindow, saveCurrentWindow } from '@/features/workspaces/workspaceService';
import popupStyle from '../popup/style.css?raw';
import { deletionNoticeKey } from '@/features/workspaces/remoteDeletion';

const storage = vi.hoisted(() => new Map<string, unknown>());
const authEvents = vi.hoisted(() => ({ changed: (() => {}) as (event?: import('@supabase/supabase-js').AuthChangeEvent, session?: import('@supabase/supabase-js').Session | null) => void }));
const requestPermission = vi.hoisted(() => vi.fn(async () => true));

// Entry points bootstrap themselves; render their roots explicitly in these tests.
vi.mock('react-dom/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-dom/client')>();
  return { ...original, default: { createRoot: () => ({ render: vi.fn() }) } };
});
vi.mock('wxt/browser', () => {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  return { browser: {
    commands: { getAll: vi.fn(async () => []) },
    runtime: { getURL: vi.fn((path: string) => `chrome-extension://fixture${path}`), openOptionsPage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => undefined) },
    permissions: { request: requestPermission },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(`session:${key}`) })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => storage.set(`session:${key}`, value)); }),
        remove: vi.fn(async (key: string) => { storage.delete(`session:${key}`); }),
      },
      local: {
        get: vi.fn(async (key: string | string[] | null) => Object.fromEntries((key === null ? [...storage.keys()] : Array.isArray(key) ? key : [key]).map((item) => [item, storage.get(item)]))),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => storage.set(key, value)); }),
        remove: vi.fn(async (keys: string[]) => { keys.forEach((key) => storage.delete(key)); }),
      },
      onChanged: event(),
    },
    windows: { getCurrent: vi.fn(async () => ({ id: 1, tabs: [] })), get: vi.fn(async (id: number) => ({ id, tabs: [] })) },
    tabs: { onCreated: event(), onRemoved: event(), onUpdated: event(), onMoved: event() },
  } };
});
vi.mock('@/features/workspaces/workspaceService', () => ({
  resolveWorkspaceStateForWindow: vi.fn(async () => ({ status: 'unbound', record: null })),
  saveCurrentWindow: vi.fn(),
  deleteWorkspace: vi.fn(async () => undefined),
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

it('retains the remote-deletion popup until acknowledgement, then shows the ordinary unsaved window', async () => {
  const session = loggedIn('A'), owner = JSON.stringify([config.url, session.user.id]), scope = `workspaces:${owner}`;
  vi.mocked(authService.session).mockResolvedValue(session);
  storage.set('supabaseConfig', config); storage.set('windowstash-data-owner:v1', owner);
  storage.set('windowstash-auth:sb-project-auth-token', JSON.stringify(session));
  const notice = { id: 'event:window-1', workspaceId: 'deleted-id', deletedAt: '2026-10-14T00:00:00Z', windowId: 1, tabs: [] };
  storage.set(deletionNoticeKey(scope), { [notice.id]: notice }); storage.set(`session:windowDeletion:1:${owner}`, notice.id);
  await renderPopup();
  expect(container.textContent).toContain('此工作区已被删除');
  expect([...container.querySelectorAll('button')].map(item => item.textContent)).toEqual(['我知道了']);
  act(() => root.unmount()); root = createRoot(container); await renderPopup();
  expect(container.textContent).toContain('此工作区已被删除');
  await click('我知道了');
  expect(container.textContent).not.toContain('此工作区已被删除'); expect(container.textContent).toContain('未保存');
  expect(storage.get(deletionNoticeKey(scope))).toEqual({});
  expect(saveCurrentWindow).not.toHaveBeenCalled();
});

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
  storage.set('windowstash-data-owner:v1', JSON.stringify([config.url, 'A']));
  storage.set('windowstash-auth:sb-project-auth-token', JSON.stringify({ user: { id: 'A' } }));
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
  expect(container.textContent).toContain('正在准备当前工作区');
  expect(button('保存当前状态').disabled).toBe(true);
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

function loggedIn(userId = 'A') {
  storage.set('supabaseConfig', config);
  storage.set('windowstash-data-owner:v1', JSON.stringify([config.url, userId]));
  storage.set('windowstash-auth:sb-project-auth-token', JSON.stringify({ user: { id: userId } }));
  const session = { user: { id: userId, email: userId + '@example.invalid' } } as Awaited<ReturnType<typeof authService.requireSession>>;
  vi.mocked(authService.session).mockResolvedValue(session);
  return session;
}

it.each(['cancel', 'confirm', 'expired-session', 'delete-failed'] as const)('uses the custom delete dialog and preserves deletion guards: %s', async (action) => {
  const session = loggedIn();
  vi.mocked(authService.requireSession).mockResolvedValue(session);
  const record: Awaited<ReturnType<typeof workspaceRepository.list>>[number] = {
    accountStorageKey: 'workspaces:' + JSON.stringify([config.url, 'A']),
    content: { id: 'delete-fixture', name: '待确认工作区', status: 'active', tabs: [], activeTabIndex: 0, createdAt: '', updatedAt: '' },
    sync: { syncStatus: 'synced', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: '', lastSyncError: null },
  };
  vi.mocked(workspaceRepository.list).mockResolvedValue([record]);
  window.confirm = vi.fn();
  await renderOptions();
  const dialog = container.querySelector<HTMLDialogElement>('.delete-dialog')!;
  // linkedom lacks the browser's dialog methods; model only opening and closing.
  Object.assign(dialog, { open: false, showModal() { this.open = true; }, close() { this.open = false; } });
  await act(async () => container.querySelector<HTMLButtonElement>('.more-button')!.click());
  await click('删除');
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('确定删除“待确认工作区”？');
  expect(window.confirm).not.toHaveBeenCalled();
  expect(deleteWorkspace).not.toHaveBeenCalled();
  if (action === 'expired-session') vi.mocked(authService.requireSession).mockRejectedValueOnce(new Error('请重新登录'));
  if (action === 'delete-failed') vi.mocked(deleteWorkspace).mockRejectedValueOnce(new Error('删除失败，请重试'));
  if (action === 'confirm') {
    vi.mocked(deleteWorkspace).mockImplementationOnce(async () => { vi.mocked(workspaceRepository.list).mockResolvedValue([]); });
    await act(async () => { const confirm = button('删除工作区'); confirm.click(); confirm.click(); });
    expect(deleteWorkspace).toHaveBeenCalledExactlyOnceWith(record.content.id, record.accountStorageKey);
    expect(container.querySelector('.workspace-row')).toBeNull();
    expect(container.querySelector('.success-toast')?.textContent).toBe('「待确认工作区」已删除');
  } else {
    await click(action === 'cancel' ? '取消' : '删除工作区');
    if (action === 'delete-failed') expect(deleteWorkspace).toHaveBeenCalledExactlyOnceWith(record.content.id, record.accountStorageKey);
    else expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(container.querySelector('.success-toast')).toBeNull();
    if (action === 'expired-session') expect(container.querySelector('.row-error')?.textContent).toBe('请重新登录');
    if (action === 'delete-failed') {
      expect(container.querySelector('.row-error')?.textContent).toBe('删除失败，请重试');
      expect(container.querySelector('.workspace-row')).not.toBeNull();
    }
  }
  expect(dialog.open).toBe(false);
});

it('preserves manager DOM and search during repeated focus/pageshow checks and same-user auth events', async () => {
  const session = loggedIn();
  await renderOptions();
  const dashboard = container.querySelector('.dashboard');
  await enter(0, 'kept search');
  let finish!: (session: Awaited<ReturnType<typeof authService.session>>) => void;
  vi.mocked(authService.session).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.querySelector('.dashboard')).toBe(dashboard);
  expect(container.querySelector('[inert]')).not.toBeNull();
  expect(container.textContent).not.toContain('正在检查登录状态');
  await act(async () => finish(session));
  for (let i = 0; i < 3; i++) {
    await switchTabs();
    await act(async () => window.dispatchEvent(new Event('pageshow')));
    await act(async () => authEvents.changed('TOKEN_REFRESHED', session));
    await act(async () => authEvents.changed('SIGNED_IN', session));
    expect(container.querySelector('.dashboard')).toBe(dashboard);
    expect(container.querySelector('input')?.value).toBe('kept search');
  }
});

it('opens authenticated popup repeatedly with one prepared snapshot and rechecks each time', async () => {
  loggedIn();
  for (let i = 0; i < 3; i++) {
    const checks = vi.mocked(authService.session).mock.calls.length;
    await renderPopup();
    expect(container.textContent).toContain('保存当前状态');
    expect(container.textContent).not.toContain('正在识别当前工作区');
    expect(vi.mocked(authService.session).mock.calls.length).toBeGreaterThan(checks);
    expect(button('保存当前状态').disabled).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
  }
});

it('retains popup on same-user token storage notifications but hides it for an account switch', async () => {
  const session = loggedIn();
  await renderPopup();
  const shell = container.querySelector('.popup-shell');
  const changed = vi.mocked(browser.storage.onChanged.addListener).mock.calls.find(([callback]) => callback.length === 2)![0];
  let finish!: (session: Awaited<ReturnType<typeof authService.session>>) => void;
  vi.mocked(authService.session).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => changed({ 'windowstash-auth:sb-project-auth-token': { oldValue: JSON.stringify(session), newValue: JSON.stringify({ ...session, access_token: 'renewed' }) } }, 'local'));
  expect(container.querySelector('.popup-shell')).toBe(shell);
  expect(container.querySelector('[inert]')).not.toBeNull();
  await act(async () => finish(session));
  const next = loggedIn('B');
  vi.mocked(authService.session).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => changed({ 'windowstash-data-owner:v1': { oldValue: JSON.stringify([config.url, 'A']), newValue: JSON.stringify([config.url, 'B']) } }, 'local'));
  expect(container.querySelector('[data-popup-state="ready"]')).toBeNull();
  await act(async () => finish(next));
  expect(container.textContent).toContain('保存当前状态');
});

it('discards a late failed recheck and recovers after the latest check succeeds', async () => {
  const session = loggedIn();
  await renderOptions();
  let fail!: (error: Error) => void;
  vi.mocked(authService.session).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => authEvents.changed('SIGNED_OUT', null));
  await act(async () => fail(new Error('older request failed')));
  expect(container.querySelector('.dashboard')).not.toBeNull();
  vi.mocked(authService.session).mockRejectedValueOnce(new Error('host unavailable'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.querySelector('.dashboard')).toBeNull();
  vi.mocked(authService.session).mockResolvedValue(session);
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.querySelector('.dashboard')).not.toBeNull();
});

it('uses each current Chrome window and account scope rather than a previous popup snapshot', async () => {
  loggedIn();
  vi.mocked(browser.windows.getCurrent).mockResolvedValueOnce({ id: 10, tabs: [] } as never);
  await renderPopup();
  expect(resolveWorkspaceStateForWindow).toHaveBeenLastCalledWith(10, [], 'workspaces:' + JSON.stringify([config.url, 'A']), true);
  act(() => root.unmount());
  root = createRoot(container);
  vi.mocked(browser.windows.getCurrent).mockResolvedValueOnce({ id: 20, tabs: [] } as never);
  await renderPopup();
  expect(resolveWorkspaceStateForWindow).toHaveBeenLastCalledWith(20, [], 'workspaces:' + JSON.stringify([config.url, 'A']), true);
});

it('invalidates prefetched window metadata when tabs change while authentication is pending', async () => {
  const session = loggedIn();
  let finish!: (value: Awaited<ReturnType<typeof authService.session>>) => void;
  vi.mocked(authService.session).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await renderPopup();
  vi.mocked(browser.windows.getCurrent).mockResolvedValueOnce({ id: 30, tabs: [] } as never);
  const callbacks = vi.mocked(browser.tabs.onUpdated.addListener).mock.calls;
  await act(async () => callbacks.forEach(([callback]) => callback(1, {}, { windowId: 30 } as never)));
  await act(async () => finish(session));
  expect(resolveWorkspaceStateForWindow).toHaveBeenLastCalledWith(30, [], 'workspaces:' + JSON.stringify([config.url, 'A']), true);
  expect(container.textContent).toContain('保存当前状态');
});

it('never displays an old project snapshot when the project changes during authentication', async () => {
  loggedIn();
  let finish!: (value: Awaited<ReturnType<typeof authService.session>>) => void;
  vi.mocked(authService.session).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await renderPopup();
  storage.set('supabaseConfig', { url: 'https://other.supabase.co', publishableKey: 'other-public-key' });
  vi.mocked(authService.session).mockResolvedValue(null);
  await act(async () => finish({ user: { id: 'A' } } as Awaited<ReturnType<typeof authService.requireSession>>));
  expect(container.textContent).toContain('开始设置');
  expect(resolveWorkspaceStateForWindow).not.toHaveBeenCalled();
});

it('retries failed initial window reads without displaying actions before resolution', async () => {
  loggedIn();
  vi.mocked(browser.windows.getCurrent).mockRejectedValueOnce(new Error('window unavailable'));
  await renderPopup();
  expect(container.textContent).toContain('window unavailable');
  expect(button('保存当前状态').disabled).toBe(true);
  await click('重试');
  expect(container.textContent).toContain('保存当前状态');
  expect(button('保存当前状态').disabled).toBe(false);
});

it('terminates initialization safely when relevant storage changes during every resolution', async () => {
  loggedIn();
  vi.mocked(resolveWorkspaceStateForWindow).mockImplementation(async () => {
    for (const [callback] of vi.mocked(browser.storage.onChanged.addListener).mock.calls) {
      callback({ ['workspaces:' + JSON.stringify([config.url, 'A'])]: { newValue: {} } }, 'local');
    }
    return { status: 'unbound', workspaceId: null, record: null, source: null };
  });
  await renderPopup();
  expect(resolveWorkspaceStateForWindow).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain('当前窗口持续变化，请稍后重试');
  expect(button('保存当前状态').disabled).toBe(true);
  vi.mocked(resolveWorkspaceStateForWindow).mockResolvedValue({ status: 'unbound', workspaceId: null, record: null, source: null });
  await click('重试');
  expect(button('保存当前状态').disabled).toBe(false);
});

it('does not restart popup preparation for another account or persistent association writes', async () => {
  loggedIn();
  vi.mocked(resolveWorkspaceStateForWindow).mockImplementation(async () => {
    for (const [callback] of vi.mocked(browser.storage.onChanged.addListener).mock.calls) callback({ 'workspaces:other': { newValue: {} }, 'persistentWindowAssociation:other': { newValue: {} } }, 'local');
    return { status: 'unbound', workspaceId: null, record: null, source: null };
  });
  await renderPopup();
  expect(resolveWorkspaceStateForWindow).toHaveBeenCalledOnce();
  expect(button('保存当前状态').disabled).toBe(false);
  vi.mocked(resolveWorkspaceStateForWindow).mockResolvedValue({ status: 'unbound', workspaceId: null, record: null, source: null });
});

it('ignores identical auth storage writes and unrelated companion diagnostic writes', async () => {
  loggedIn();
  await renderOptions();
  const checks = vi.mocked(authService.session).mock.calls.length;
  const changed = vi.mocked(browser.storage.onChanged.addListener).mock.calls.find(([callback]) => callback.length === 2)![0];
  await act(async () => changed({ 'windowstash-data-owner:v1': { oldValue: 'A', newValue: 'A' }, 'windowstash-companion:diagnostics': { newValue: 'connected' } }, 'local'));
  expect(vi.mocked(authService.session).mock.calls.length).toBe(checks);
  expect(container.querySelector('.dashboard')).not.toBeNull();
});

it('does not let an older manager data read overwrite newer workspace changes', async () => {
  loggedIn();
  let finish!: (records: Awaited<ReturnType<typeof workspaceRepository.list>>) => void;
  vi.mocked(workspaceRepository.list).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await renderOptions();
  const record = (name: string): Awaited<ReturnType<typeof workspaceRepository.list>>[number] => ({ content: { id: 'workspace-1', name, status: 'active', tabs: [], activeTabIndex: 0, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' }, sync: { syncStatus: 'synced', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: '2026-11-13T00:00:00Z', lastSyncError: null } });
  vi.mocked(workspaceRepository.list).mockResolvedValue([record('New workspace')]);
  const callbacks = vi.mocked(browser.storage.onChanged.addListener).mock.calls;
  await act(async () => callbacks.forEach(([callback]) => callback({ 'workspaces:current': { newValue: {} } }, 'local')));
  expect(container.textContent).toContain('New workspace');
  await act(async () => finish([record('Old workspace')]));
  expect(container.textContent).toContain('New workspace');
  expect(container.textContent).not.toContain('Old workspace');
});

it('includes a neutral shell before JavaScript and keeps every operation disabled', () => {
  const dom = parseHTML(popupHtml);
  expect(dom.document.querySelector('.popup-header')?.textContent).toContain('WindowStash');
  expect(dom.document.querySelector('.popup-content')).not.toBeNull();
  expect(dom.document.querySelector('.popup-actions')).not.toBeNull();
  expect(dom.document.querySelector('.manager-link')).not.toBeNull();
  expect([...dom.document.querySelectorAll('button')].every((item) => item.hasAttribute('disabled'))).toBe(true);
  expect(dom.document.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(dom.document.body.textContent).not.toContain('关联已有工作区');
  expect(popupStyle).not.toMatch(/associate-link|association-(?:shell|content|list)/);
});

it('keeps the full neutral popup shell while workspace identification is pending', async () => {
  loggedIn();
  let finish!: (value: Awaited<ReturnType<typeof resolveWorkspaceStateForWindow>>) => void;
  vi.mocked(resolveWorkspaceStateForWindow).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await renderPopup();
  expect(container.querySelector('.popup-header')?.textContent).toContain('WindowStash');
  expect(container.querySelector('.popup-actions')).not.toBeNull();
  for (const text of ['保存当前状态', '保存并关闭窗口', '重新打开工作区']) expect(button(text).disabled).toBe(true);
  expect(container.textContent).not.toContain('关联已有工作区');
  expect(container.querySelector('[data-popup-state="ready"]')).toBeNull();
  await act(async () => finish({ status: 'unbound', record: null, workspaceId: null, source: null }));
  expect(container.querySelector('[data-popup-state="ready"]')).not.toBeNull();
  expect(button('保存当前状态').disabled).toBe(false);
  expect(container.textContent).not.toContain('关联已有工作区');
});

it('coalesces overlapping focus/pageshow and same-account auth checks', async () => {
  const session = loggedIn();
  await renderPopup();
  const checks = vi.mocked(authService.session).mock.calls.length;
  let finish!: (value: Awaited<ReturnType<typeof authService.session>>) => void;
  vi.mocked(authService.session).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('pageshow'));
    authEvents.changed('TOKEN_REFRESHED', session);
  });
  expect(vi.mocked(authService.session).mock.calls.length).toBe(checks + 1);
  expect(container.querySelector('[inert]')).not.toBeNull();
  await act(async () => finish(session));
  expect(container.querySelector('[inert]')).toBeNull();
  expect(button('保存当前状态').disabled).toBe(false);
});

it.each(['resolved', 'unbound'] as const)('keeps normal popup actions without manual association for %s windows', async (status) => {
  loggedIn();
  const record: Awaited<ReturnType<typeof workspaceRepository.list>>[number] = {
    content: { id: 'workspace-1', name: 'Existing workspace', status: 'active', tabs: [{ title: 'Saved page', url: 'https://saved.example/', position: 0, pinned: false }], activeTabIndex: 0, createdAt: '', updatedAt: '' },
    sync: { syncStatus: 'synced', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: '', lastSyncError: null },
  };
  vi.mocked(resolveWorkspaceStateForWindow).mockResolvedValue(status === 'resolved'
    ? { status, workspaceId: record.content.id, record, source: 'binding' }
    : { status, workspaceId: null, record: null, source: null });
  await renderPopup();
  expect(container.textContent).not.toContain('关联已有工作区');
  expect(container.querySelector('.associate-link, .association-shell')).toBeNull();
  expect(container.querySelector('.reopen-workspace') !== null).toBe(status === 'resolved');
  if (status === 'resolved') {
    expect(button('Existing workspace').getAttribute('aria-label')).toContain('重命名');
    expect(container.querySelector('.view-changes')?.textContent).toContain('项变更');
    await act(async () => container.querySelector<HTMLButtonElement>('.view-changes')!.click());
    expect(container.textContent).toContain('本次保存的变更');
    await click('← 返回');
    expect(container.querySelector('.reopen-workspace')?.getAttribute('aria-label')).toBe('重新打开工作区');
    await click('重新打开');
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'REOPEN_WORKSPACE', workspaceId: record.content.id, sourceWindowId: 1 }));
  } else await enter(0, 'New workspace');
  const name = status === 'resolved' ? record.content.name : 'New workspace';
  await click('保存当前状态');
  expect(saveCurrentWindow).toHaveBeenCalledWith(expect.objectContaining({ windowId: 1, name, closeAfterSave: false }));
  await click('保存并关闭窗口');
  expect(saveCurrentWindow).toHaveBeenLastCalledWith(expect.objectContaining({ windowId: 1, name, closeAfterSave: true }));
  await click('管理工作区 →');
  expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce();
  vi.mocked(resolveWorkspaceStateForWindow).mockResolvedValue({ status: 'unbound', workspaceId: null, record: null, source: null });
});
