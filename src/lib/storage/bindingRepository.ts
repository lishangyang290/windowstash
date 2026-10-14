import { accountStorageKey } from './accountScope';
import { browser } from 'wxt/browser';
const operations = new Map<string, Promise<unknown>>();
function locked<T>(storageKey: string, task: () => Promise<T>): Promise<T> {
  const name = `windowstash-binding:${storageKey}`;
  if (globalThis.navigator?.locks) return navigator.locks.request(name, task).then(result => result);
  const result = (operations.get(name) ?? Promise.resolve()).then(task, task);
  operations.set(name, result);
  void result.finally(() => { if (operations.get(name) === result) operations.delete(name); }).catch(() => undefined);
  return result;
}

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
    await locked(storageKey, async () => {
    const tombstoneKey = storageKey.replace(/^windowBinding:\d+/, 'deleteTombstones');
    const noticeKey = storageKey.replace(/^windowBinding:\d+/, 'workspaceDeletionNotices');
    const state = await browser.storage.local.get([tombstoneKey, noticeKey]);
    if ((state[tombstoneKey] as Record<string, unknown> | undefined)?.[workspaceId]
      || Object.values(state[noticeKey] as Record<string, { workspaceId: string }> ?? {}).some(notice => notice.workspaceId === workspaceId)) throw new Error('工作区已被删除');
    await browser.storage.session.set({ [storageKey]: workspaceId });
    await browser.storage.session.remove(storageKey.replace(/^windowBinding:/, 'windowBindingSuppressed:'));
    });
  },
  async suppress(windowId: number, requestedKey?: string): Promise<void> {
    const storageKey = await key(windowId, requestedKey);
    await locked(storageKey, async () => {
    await browser.storage.session.set({ [storageKey.replace(/^windowBinding:/, 'windowBindingSuppressed:')]: true });
    await browser.storage.session.remove(storageKey);
    });
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
