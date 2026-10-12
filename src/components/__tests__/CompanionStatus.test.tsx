import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const check = vi.hoisted(() => vi.fn());
vi.mock('@/lib/companion/connection', () => ({ checkCompanion: check }));
import { CompanionStatus } from '../CompanionStatus';
let root: ReturnType<typeof createRoot>, container: HTMLElement;
const result = { companionRunning: true, sharedAuth: false, instanceId: 'a'.repeat(64) };
beforeEach(() => {
  vi.useFakeTimers(); check.mockReset(); check.mockResolvedValue(result);
  const dom = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement });
  Object.assign(window, { location: { search: '?companionRoute=route' } });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.getElementById('root')!; root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });
async function mount() { await act(async () => root.render(<CompanionStatus />)); }
async function click() { await act(async () => container.querySelector('button')!.click()); }
describe('Companion detection feedback', () => {
  it('shows real pending state, blocks repeats and waits for the actual response', async () => {
    await mount();
    let resolve!: (value: typeof result) => void;
    check.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await click();
    expect(container.querySelector('button')!.textContent).toBe('检测中…');
    expect(container.querySelector('button')!.disabled).toBe(true);
    await click();
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(check).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('检测完成');
    await act(async () => resolve(result));
    expect(container.textContent).toContain('检测完成');
    expect(container.textContent).toContain('Companion 通信正常');
    expect(container.textContent).not.toContain('账号共享尚未启用');
  });
  it('restarts completion feedback even when results and clock are unchanged', async () => {
    await mount(); await click();
    act(() => vi.advanceTimersByTime(1500));
    await click();
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toContain('检测完成');
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).not.toContain('检测完成');
    expect(container.textContent).toContain('最近检测');
    expect(check).toHaveBeenLastCalledWith('route');
  });
  it('shows failure without a success toast and permits retry', async () => {
    await mount(); check.mockRejectedValueOnce(new Error('未找到本机组件，请打开 Companion 后重试'));
    await click();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('未找到本机组件');
    expect(container.textContent).not.toContain('检测完成');
    expect(container.querySelector('button')!.disabled).toBe(false);
    await click(); expect(container.textContent).toContain('检测完成');
  });
});
