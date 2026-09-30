import { describe, expect, it } from 'vitest';
import { applyLazyTabAppearance } from '@/features/workspaces/lazyTabAppearance';

function fakeDocument() {
  const link = { id: 'lazy-tab-favicon', rel: 'icon', href: 'chrome-extension://test/lazy-favicon.svg' };
  return {
    title: 'WindowStash',
    link,
    querySelector: () => link,
  };
}

describe('lazyTabAppearance', () => {
  it('applies the saved title and favicon without navigating the tab', () => {
    const doc = fakeDocument();

    applyLazyTabAppearance({ title: 'ChatGPT', favIconUrl: 'https://chatgpt.com/favicon.ico' }, doc as unknown as Document);

    expect(doc.title).toBe('ChatGPT');
    expect(doc.link.href).toBe('https://chatgpt.com/favicon.ico');
  });

  it('gives fifty lazy tabs their own titles without loading any original URL', () => {
    const documents = Array.from({ length: 50 }, (_, index) => {
      const doc = fakeDocument();
      applyLazyTabAppearance({ title: `Saved ${index}`, favIconUrl: `https://example.com/${index}.ico` }, doc as unknown as Document);
      return doc;
    });

    expect(documents.map((doc) => doc.title)).toEqual(Array.from({ length: 50 }, (_, index) => `Saved ${index}`));
  });

  it('keeps the neutral favicon when the saved favicon is unusable', () => {
    const doc = fakeDocument();

    applyLazyTabAppearance({ title: 'Saved page', favIconUrl: 'not-a-favicon' }, doc as unknown as Document);

    expect(doc.title).toBe('Saved page');
    expect(doc.link.href).toBe('chrome-extension://test/lazy-favicon.svg');
  });
});
