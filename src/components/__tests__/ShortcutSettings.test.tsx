import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getAll: vi.fn(), create: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { commands: { getAll: mocks.getAll }, tabs: { create: mocks.create } } }));
import { ShortcutSettings } from '../ShortcutSettings';

describe('ShortcutSettings', () => {
  it.each(['', 'Ctrl+Shift+S'])('shows the assigned shortcut or 未设置: %s', async shortcut => {
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
    mocks.getAll.mockResolvedValue([{ name: 'quick-save-workspace', shortcut }]); mocks.create.mockResolvedValue({});
    const container = document.getElementById('root')!; const root = createRoot(container as unknown as Element);
    const onOpened = vi.fn();
    try {
      await act(async () => root.render(<ShortcutSettings onOpened={onOpened} />));
      expect(container.textContent).toContain(shortcut || '未设置');
      expect(container.querySelector('button')?.getAttribute('role')).toBe('menuitem');
      await act(async () => container.querySelector('button')!.click());
      expect(mocks.create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
      expect(onOpened).toHaveBeenCalledOnce();
      mocks.getAll.mockResolvedValue([{ name: 'quick-save-workspace', shortcut: 'Alt+S' }]);
      await act(async () => window.dispatchEvent(new window.Event('focus')));
      expect(container.textContent).toContain('Alt+S');
    } finally { act(() => root.unmount()); }
  });
});
