import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it } from 'vitest';
import { VisibilityToggleInput } from '@/components/VisibilityToggleInput';

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount());
});

describe('VisibilityToggleInput', () => {
  it('starts hidden and toggles each input independently without changing its value', async () => {
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement, Event: window.Event });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
    const container = document.getElementById('root')!;
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<>
      <VisibilityToggleInput value="abc12345" onChange={() => undefined} />
      <VisibilityToggleInput value="abc12346" onChange={() => undefined} />
    </>));

    const inputs = [...container.querySelectorAll('input')];
    const buttons = [...container.querySelectorAll('button')];
    expect(inputs.map((input) => input.type)).toEqual(['password', 'password']);
    await act(async () => buttons[0]!.dispatchEvent(new window.Event('click', { bubbles: true })));
    expect(inputs.map((input) => input.type)).toEqual(['text', 'password']);
    expect(inputs.map((input) => input.value)).toEqual(['abc12345', 'abc12346']);

    await act(async () => buttons[0]!.dispatchEvent(new window.Event('click', { bubbles: true })));
    await act(async () => buttons[1]!.dispatchEvent(new window.Event('click', { bubbles: true })));
    expect(inputs.map((input) => input.type)).toEqual(['password', 'text']);
  });
});
