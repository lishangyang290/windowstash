import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connection: vi.fn(), listeners: new Map<string, (event: { payload: string | null }) => void>() }));
vi.mock('./lib/chromeBridge', () => ({ chromeBridge: mocks }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, listener) => { mocks.listeners.set(name, listener); return () => mocks.listeners.delete(name); }) }));
import { NativeHostStatus } from './NativeHostStatus';
let root: ReturnType<typeof createRoot>, container: HTMLElement;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); mocks.listeners.clear();
  mocks.connection.mockResolvedValue({ host_error: null });
  const dom = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.getElementById('root')!; root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });
it('keeps the account UI visible and clears the registration error after an automatic retry', async () => {
  mocks.connection.mockResolvedValueOnce({ host_error: '无法更新注册路径' });
  await act(async () => root.render(<NativeHostStatus><span>原工作区</span></NativeHostStatus>));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法更新注册路径');
  expect(container.textContent).toContain('原工作区');
  await act(async () => mocks.listeners.get('native-host-status')!({ payload: null }));
  expect(mocks.connection).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('shows rejected startup checks and supports an immediate repair', async () => {
  mocks.connection.mockRejectedValueOnce('无法找到 Chrome Profile 目录');
  await act(async () => root.render(<NativeHostStatus>账号保持登录</NativeHostStatus>));
  expect(container.textContent).toContain('无法找到 Chrome Profile 目录');
  await act(async () => container.querySelector('button')!.click());
  expect(mocks.connection).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('does not overlap slow checks', async () => {
  mocks.connection.mockReturnValue(new Promise(() => {}));
  await act(async () => root.render(<NativeHostStatus>工作区</NativeHostStatus>));
  await act(async () => {
    mocks.listeners.get('popover-opened')!({ payload: null });
    mocks.listeners.get('popover-opened')!({ payload: null });
  });
  expect(mocks.connection).toHaveBeenCalledOnce();
});
it('receives native errors while the account remains mounted', async () => {
  await act(async () => root.render(<NativeHostStatus>原账号</NativeHostStatus>));
  await act(async () => mocks.listeners.get('native-host-status')!({ payload: '组件缺失' }));
  expect(container.textContent).toContain('组件缺失');
  expect(container.textContent).toContain('原账号');
});
