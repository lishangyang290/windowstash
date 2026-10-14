import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ native: vi.fn(), transfer: vi.fn(), replace: vi.fn(), session: vi.fn(), config: vi.fn(), resetLink: vi.fn() }));
vi.mock('@/lib/companion/auth', async (original) => ({ ...await original<typeof import('@/lib/companion/auth')>(), nativeAuth: mocks.native, authorizeCompanion: mocks.transfer }));
vi.mock('@/lib/supabase/authService', () => ({ authService: { session: mocks.session } }));
vi.mock('@/lib/supabase/client', () => ({ getSupabaseConfig: mocks.config, resetMissingCompanionLink: mocks.resetLink }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { getURL: (path: string) => path } } }));
vi.mock('@/components/SupabaseConfigForm', () => ({ getSetupMode: () => undefined, SupabaseConfigForm: ({ onSaved }: { onSaved: () => void }) => <button onClick={() => { mocks.config.mockResolvedValue({ url: 'https://new.invalid', publishableKey: 'new-key' }); onSaved(); }}>保存配置</button> }));
import { CompanionLogin } from '../CompanionLogin';
import { NativeAuthError } from '@/lib/companion/auth';
let root: ReturnType<typeof createRoot>;
let container: HTMLElement;
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.transfer.mockResolvedValue(undefined);
  mocks.session.mockResolvedValue({ user: { id: 'A', email: 'a@example.invalid' } });
  mocks.config.mockResolvedValue({ url: 'https://fixture.invalid', publishableKey: 'fixture-key' });
  const dom = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document: dom.document, window: dom.window, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event });
  const search = `?companionLogin=${'a'.repeat(64)}&companionRoute=${'b'.repeat(64)}`;
  const taskLocation = { href: `https://fixture.invalid/authorize.html${search}`, search, replace: mocks.replace };
  vi.stubGlobal('location', taskLocation);
  Object.assign(window, { location: taskLocation, history: {
    pushState: (_state: unknown, _title: string, url: string) => { const next = new URL(String(url)); Object.assign(taskLocation, { href: next.href, search: next.search }); },
    replaceState: (_state: unknown, _title: string, url: string) => { const next = new URL(String(url)); Object.assign(taskLocation, { href: next.href, search: next.search }); },
  } });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.getElementById('root')!; root = createRoot(container);
  await act(async () => root.render(<CompanionLogin login={() => null} />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function confirm() { await act(async () => container.querySelector('button')!.click()); }

it('offers fresh login for a missing grant and completes the same authorization request', async () => {
  mocks.session.mockRejectedValueOnce(new NativeAuthError('not_linked', '关联已失效'));
  mocks.resetLink.mockResolvedValue(undefined);
  await act(async () => root.render(<CompanionLogin key="missing-link" login={(refresh) => <button onClick={() => { mocks.session.mockResolvedValue({ user: { id: 'Fresh', email: 'fresh@example.invalid' } }); void refresh(); }}>完成登录</button>} />));
  expect(container.textContent).toContain('重新登录');
  mocks.session.mockResolvedValue(null);
  await confirm();
  expect(mocks.resetLink).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('完成登录');
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '完成登录')!.click());
  mocks.native.mockResolvedValue({ completed: true });
  await confirm();
  expect(mocks.transfer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user: expect.objectContaining({ id: 'Fresh' }) }), 'a'.repeat(64), 'b'.repeat(64));
  expect(container.textContent).toContain('登录已完成');
});

it('offers retry without resetting linkage after a network error', async () => {
  mocks.session.mockRejectedValueOnce(new NativeAuthError('network_unavailable', '网络不可用'));
  await act(async () => root.render(<CompanionLogin key="offline" login={() => null} />));
  expect(container.textContent).toContain('重试');
  expect(container.textContent).not.toContain('重新登录');
  await confirm();
  expect(mocks.resetLink).not.toHaveBeenCalled();
});
describe('authorization success navigation', () => {
  it('waits for desktop completion, counts down, and replaces the task with the clean manager URL', async () => {
    mocks.native.mockResolvedValue({ completed: true });
    await confirm();
    expect(container.textContent).toContain('3 秒后自动进入工作区管理器');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(container.textContent).toContain('2 秒后自动进入工作区管理器');
    expect(mocks.replace).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('/options.html');
  });
  it('never navigates while desktop completion is pending or fails', async () => {
    mocks.native.mockResolvedValueOnce({ completed: false }).mockResolvedValue({ failure: 'workspace_unavailable' });
    await confirm();
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(container.textContent).toContain('暂时无法读取工作区');
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it('cancels navigation when the authorization page unmounts', async () => {
    mocks.native.mockResolvedValue({ completed: true }); await confirm();
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});


it('continues the same Companion request after editing configuration and logging in', async () => {
  mocks.session.mockResolvedValue(null);
  await act(async () => root.render(<CompanionLogin key="logged-out" login={(refresh) => <button onClick={() => { mocks.session.mockResolvedValue({ user: { id: 'B', email: 'b@example.invalid' } }); void refresh(); }}>完成登录</button>} />));
  expect(container.textContent).toContain('完成登录');
  expect(container.querySelector('.login-config')).toBeNull();
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.config-steps button')[0]!.click());
  expect(container.textContent).not.toContain('完成登录');
  expect(location.search).toContain('companionLogin=');
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '保存配置')!.click());
  expect(container.textContent).toContain('完成登录');
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '完成登录')!.click());
  expect(container.textContent).toContain('b@example.invalid');
  mocks.native.mockResolvedValue({ completed: true });
  await confirm();
  expect(mocks.transfer).toHaveBeenCalledWith({ url: 'https://new.invalid', publishableKey: 'new-key' }, expect.objectContaining({ user: expect.objectContaining({ id: 'B' }) }), 'a'.repeat(64), 'b'.repeat(64));
});

it('continues an initial setup and login using the original Companion request', async () => {
  mocks.config.mockResolvedValue(null);
  mocks.session.mockResolvedValue(null);
  await act(async () => root.render(<CompanionLogin key="first-setup" login={(refresh) => <button onClick={() => { mocks.session.mockResolvedValue({ user: { id: 'C', email: 'c@example.invalid' } }); void refresh(); }}>完成登录</button>} />));
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '保存配置')!.click());
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '完成登录')!.click());
  mocks.native.mockResolvedValue({ completed: true });
  await confirm();
  expect(mocks.transfer).toHaveBeenCalledWith({ url: 'https://new.invalid', publishableKey: 'new-key' }, expect.objectContaining({ user: expect.objectContaining({ id: 'C' }) }), 'a'.repeat(64), 'b'.repeat(64));
});
