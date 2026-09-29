import { browser } from 'wxt/browser';

function key(windowId: number): string {
  return `windowBinding:${windowId}`;
}

export const bindingRepository = {
  async get(windowId: number): Promise<string | null> {
    const storageKey = key(windowId);
    const result = await browser.storage.session.get(storageKey);
    return (result[storageKey] as string | undefined) ?? null;
  },
  async set(windowId: number, workspaceId: string): Promise<void> {
    await browser.storage.session.set({ [key(windowId)]: workspaceId });
  },
  async remove(windowId: number): Promise<void> {
    await browser.storage.session.remove(key(windowId));
  },
};
