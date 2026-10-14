import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceSummary } from './types';
const state = vi.hoisted(() => ({ items: [] as WorkspaceSummary[], scope: 'A', refresh: vi.fn(), opened: undefined as (() => void) | undefined, manager: vi.fn() }));
vi.mock('./features/workspaces', () => ({ workspaceService: { cached: () => state.items, refresh: state.refresh } }));
vi.mock('./lib/cache', () => ({ cache: { currentScope: () => state.scope, workspaces: () => state.items }, sortByRecent: (items: WorkspaceSummary[]) => items }));
vi.mock('./lib/chromeBridge', () => ({ chromeBridge: { openManager: state.manager } }));
vi.mock('./ChromeConnectionPanel', () => ({ ChromeConnectionPanel: () => null, ChromeConnectionPage: () => null }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (_name: string, callback: () => void) => { state.opened = callback; return () => { state.opened = undefined; }; } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ disable: vi.fn(), enable: vi.fn(), isEnabled: vi.fn() }));
import { Launcher } from './App';
let root: ReturnType<typeof createRoot>, container: HTMLElement;
const item = (name: string): WorkspaceSummary => ({ id: name, name, tabCount: 2, updatedAt: '2026-10-13' });
beforeEach(() => {
  vi.clearAllMocks(); state.scope = 'A'; state.items = []; state.refresh.mockResolvedValue([]);
  vi.useFakeTimers();
  const dom = parseHTML('<div id="root"></div>');
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.document);
  Object.assign(window, { setTimeout, clearTimeout, setInterval, clearInterval });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.getElementById('root')!; root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<Launcher key={state.scope} config={{ url: 'https://example.invalid', publishableKey: 'fixture' }} session={{ user: { id: state.scope } } as never} onConfigChange={() => {}} onSignOut={() => {}} />));

it('shows newly synced cloud data on the single follow-up after opening the tray, without opening a manager', async () => {
  await render();
  state.refresh.mockResolvedValueOnce([]).mockResolvedValueOnce([item('New workspace')]);
  await act(async () => state.opened?.());
  expect(container.textContent).not.toContain('New workspace');
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(container.textContent).toContain('New workspace');
  expect(state.manager).not.toHaveBeenCalled();
  const calls = state.refresh.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(state.refresh).toHaveBeenCalledTimes(calls);
});

it('ignores an old UI response after a newer tray refresh', async () => {
  let finish!: (items: WorkspaceSummary[]) => void;
  state.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  state.refresh.mockResolvedValueOnce([item('New workspace')]);
  await act(async () => state.opened?.());
  await act(async () => finish([item('Old workspace')]));
  expect(container.textContent).toContain('New workspace');
  expect(container.textContent).not.toContain('Old workspace');
});

it('preserves cached rows on network failure and discards results from the previous account', async () => {
  state.items = [item('A cached')]; state.refresh.mockRejectedValueOnce(new Error('offline'));
  await render(); expect(container.textContent).toContain('A cached');
  let finish!: (items: WorkspaceSummary[]) => void;
  state.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => state.opened?.());
  state.scope = 'B'; state.items = [item('B cached')]; state.refresh.mockResolvedValueOnce(state.items);
  await render();
  await act(async () => finish([item('A private')]));
  expect(container.textContent).toContain('B cached');
  expect(container.textContent).not.toMatch(/A private|A cached/);
});
