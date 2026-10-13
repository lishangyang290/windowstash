import { accountStorageKey } from './accountScope';
import { browser } from 'wxt/browser';

function key(windowId: number, requestedKey?: string): Promise<string> {
  if (requestedKey) return Promise.resolve(requestedKey.replace(/^workspaces/, `windowBinding:${windowId}`));
  return accountStorageKey(`windowBinding:${windowId}`);
}

function suppressionKey(windowId: number): Promise<string> {
  return accountStorageKey(`windowBindingSuppressed:${windowId}`);
}

export const bindingRepository = {
  async get(windowId: number, requestedKey?: string): Promise<string | null> {
    const storageKey = await key(windowId, requestedKey);
    const result = await browser.storage.session.get(storageKey);
    return (result[storageKey] as string | undefined) ?? null;
  },
  async set(windowId: number, workspaceId: string, requestedKey?: string): Promise<void> {
    const storageKey = await key(windowId, requestedKey);
    await browser.storage.session.set({ [storageKey]: workspaceId });
    await browser.storage.session.remove(storageKey.replace(/^windowBinding:/, 'windowBindingSuppressed:'));
  },
  async suppress(windowId: number, requestedKey?: string): Promise<void> {
    const storageKey = await key(windowId, requestedKey);
    await browser.storage.session.set({ [storageKey.replace(/^windowBinding:/, 'windowBindingSuppressed:')]: true });
    await browser.storage.session.remove(storageKey);
  },
  async isSuppressed(windowId: number, requestedKey?: string): Promise<boolean> {
    const storageKey = requestedKey ? (await key(windowId, requestedKey)).replace(/^windowBinding:/, 'windowBindingSuppressed:') : await suppressionKey(windowId);
    const result = await browser.storage.session.get(storageKey);
    return result[storageKey] === true;
  },
  async remove(windowId: number, requestedKey?: string): Promise<void> {
    const storageKey = await key(windowId, requestedKey);
    await browser.storage.session.remove([storageKey, storageKey.replace(/^windowBinding:/, 'windowBindingSuppressed:')]);
  },
  async suppressWorkspace(workspaceId: string, requestedKey: string): Promise<void> {
    const bindings = await browser.storage.session.get(null);
    const suffix = requestedKey.slice('workspaces'.length);
    for (const [storageKey, value] of Object.entries(bindings)) {
      if (value !== workspaceId || !storageKey.startsWith('windowBinding:')) continue;
      const windowId = Number(storageKey.slice('windowBinding:'.length).split(':')[0]);
      if (Number.isInteger(windowId) && storageKey === `windowBinding:${windowId}${suffix}`) await this.suppress(windowId, requestedKey);
    }
  },
};
