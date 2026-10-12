import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { EmailInput, emailSuggestions } from '../EmailInput';

describe('email domain suggestions', () => {
  it('filters after @ without restricting custom or already complete addresses', () => {
    expect(emailSuggestions('name')).toEqual([]);
    expect(emailSuggestions('name@')).toContain('name@qq.com');
    expect(emailSuggestions('Name@G')).toEqual(['Name@gmail.com']);
    for (const value of ['name@gmail.com', 'name@company.example', '@g', 'name@@g', 'name @g']) expect(emailSuggestions(value)).toEqual([]);
  });
  it('selects with the keyboard without submitting, dismisses with Escape, and accepts a pointer selection', async () => {
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement, Event: window.Event });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.getElementById('root')!;
    const root = createRoot(container);
    const changes: string[] = [];
    function Form() {
      const [value, setValue] = React.useState('name@');
      return <EmailInput value={value} onChange={(next) => { changes.push(next); setValue(next); }} />;
    }
    const focus = async () => {
      const input = container.querySelector('input')!;
      Object.assign(input, { attachEvent: () => {}, detachEvent: () => {} });
      await act(async () => input.dispatchEvent(new window.Event('focusin', { bubbles: true })));
    };
    const key = async (name: string, composing = false) => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key: name, isComposing: composing });
      await act(async () => container.querySelector('input')!.dispatchEvent(event));
      return event;
    };
    try {
      await act(async () => root.render(<Form />));
      expect(container.querySelector('[role="listbox"]')).toBeNull();
      await focus();
      await key('ArrowDown');
      expect(container.querySelectorAll('[role="option"]')).toHaveLength(8);
      await key('Enter', true);
      expect(changes).toEqual([]);
      await key('Escape');
      expect(container.querySelector('[role="listbox"]')).toBeNull();
      await key('ArrowDown');
      await key('ArrowDown');
      expect((await key('Enter')).defaultPrevented).toBe(true);
      expect(changes).toEqual(['name@qq.com']);
      expect(container.querySelector('[role="listbox"]')).toBeNull();
      await act(async () => root.render(<EmailInput value="other@g" onChange={(value) => changes.push(value)} />));
      await focus();
      await key('ArrowDown');
      await act(async () => container.querySelector('[role="option"]')!.dispatchEvent(new window.Event('click', { bubbles: true })));
      expect(changes.at(-1)).toBe('other@gmail.com');
    } finally { await act(async () => root.unmount()); }
  });
});
