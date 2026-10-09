import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceActions } from './WorkspaceActions';

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => act(() => roots.splice(0).forEach((root) => root.unmount())));

function renderActions(showReopen: boolean, reopeningWorkspace = false, saveBlocked = false) {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement, Event: window.Event });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById('root')!;
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  const onReopen = vi.fn();
  act(() => root.render(<WorkspaceActions
    action={null}
    phase="idle"
    saveBlocked={saveBlocked}
    reopenBlocked={false}
    reopenLabel={saveBlocked ? '从已保存工作区恢复' : '重新打开工作区'}
    reopeningWorkspace={reopeningWorkspace}
    showReopen={showReopen}
    onSave={vi.fn()}
    onReopen={onReopen}
  />));
  return { container, onReopen };
}

describe('WorkspaceActions', () => {
  it('shows reopen only for a resolved workspace', () => {
    const resolved = renderActions(true);
    expect(resolved.container.textContent).toContain('重新打开工作区');
    act(() => resolved.container.querySelector<HTMLButtonElement>('.reopen-workspace')!.click());
    expect(resolved.onReopen).toHaveBeenCalledOnce();
  });

  it.each(['unbound', 'unavailable'])('hides reopen for %s state', () => {
    expect(renderActions(false).container.querySelector('.reopen-workspace')).toBeNull();
  });

  it('disables all actions and shows progress while reopening', () => {
    const { container } = renderActions(true, true);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];

    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[2]!.textContent).toBe('正在重新打开…');
  });

  it('keeps recovery available when damaged lazy tabs block saving', () => {
    const { container, onReopen } = renderActions(true, false, true);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];

    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[1]!.disabled).toBe(true);
    expect(buttons[2]!.disabled).toBe(false);
    expect(buttons[2]!.textContent).toBe('从已保存工作区恢复');
    act(() => buttons[2]!.click());
    expect(onReopen).toHaveBeenCalledOnce();
  });
});
