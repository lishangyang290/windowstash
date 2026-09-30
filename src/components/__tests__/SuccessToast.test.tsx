import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuccessToast } from '@/components/SuccessToast';

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  vi.useRealTimers();
});

describe('SuccessToast', () => {
  it('dismisses itself after two seconds', async () => {
    vi.useFakeTimers();
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement, Event: window.Event });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const dismiss = vi.fn();
    const container = document.getElementById('root')!;
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    act(() => root.render(<SuccessToast message="连接成功" onDismiss={dismiss} />));
    expect(container.textContent).toContain('连接成功');

    act(() => vi.advanceTimersByTime(2000));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
