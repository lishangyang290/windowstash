import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connection: vi.fn(), select: vi.fn(), openManager: vi.fn() }));
vi.mock('./lib/chromeBridge', () => ({ chromeBridge: mocks }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
import { ChromeConnectionPanel } from './ChromeConnectionPanel';
let root: ReturnType<typeof createRoot>, container: HTMLElement;
const target = { profile: 'Default', extension_id: 'a'.repeat(32) };
const status = { targets: [target], selected: { target }, error: null, host_error: null, last_received_at: null };
beforeEach(() => {
  vi.resetAllMocks(); mocks.connection.mockResolvedValue(status);
  const dom = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.getElementById('root')!; root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
describe('Chrome preferences hierarchy', () => {
  it('leaves the launcher clear when a target is already selected', async () => {
    await act(async () => root.render(<ChromeConnectionPanel compact />));
    expect(container.textContent).toBe(''); expect(container.querySelector('select')).toBeNull();
  });
  it('offers one settings action when multiple profiles need a choice', async () => {
    mocks.connection.mockResolvedValue({ ...status, targets: [target, { ...target, profile: 'Profile 1' }], selected: null });
    const manage = vi.fn();
    await act(async () => root.render(<ChromeConnectionPanel compact onManage={manage} />));
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(container.textContent).not.toContain(target.extension_id);
    act(() => container.querySelector('button')!.click()); expect(manage).toHaveBeenCalledOnce();
  });
  it('shows friendly browser choices without communication or authentication diagnostics', async () => {
    await act(async () => root.render(<ChromeConnectionPanel />));
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).toContain('默认浏览器');
    expect(container.textContent).not.toContain(target.extension_id);
    expect(container.textContent).not.toMatch(/账号共享|连接检测|Native|Profile|扩展 ID/);
    expect(container.textContent).not.toContain('打开 Chrome 检查连接');
  });
});
