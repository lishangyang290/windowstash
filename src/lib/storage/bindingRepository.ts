import { browser } from 'wxt/browser';

function key(windowId: number): string {
  return `windowBinding:${windowId}`;
}

function suppressionKey(windowId: number): string {
  return `windowBindingSuppressed:${windowId}`;
}

export const bindingRepository = {
  async get(windowId: number): Promise<string | null> {
    const storageKey = key(windowId);
    const result = await browser.storage.session.get(storageKey);
    return (result[storageKey] as string | undefined) ?? null;
  },
  async set(windowId: number, workspaceId: string): Promise<void> {
    await browser.storage.session.set({ [key(windowId)]: workspaceId });
    await browser.storage.session.remove(suppressionKey(windowId));
  },
  async suppress(windowId: number): Promise<void> {
    await browser.storage.session.set({ [suppressionKey(windowId)]: true });
    await browser.storage.session.remove(key(windowId));
  },
  async isSuppressed(windowId: number): Promise<boolean> {
    const storageKey = suppressionKey(windowId);
    const result = await browser.storage.session.get(storageKey);
    return result[storageKey] === true;
  },
  async remove(windowId: number): Promise<void> {
    await browser.storage.session.remove([key(windowId), suppressionKey(windowId)]);
  },
};
