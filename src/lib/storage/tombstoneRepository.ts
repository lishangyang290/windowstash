import { accountStorageKey } from './accountScope';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';
import type { DeleteTombstone } from '@/types/workspace';

type TombstoneMap = Record<string, DeleteTombstone>;
let writes = Promise.resolve();
function write(storageKey: string, task: () => Promise<void>): Promise<void> {
  if (globalThis.navigator?.locks) return navigator.locks.request(`windowstash-tombstones:${storageKey}`, task).then(() => undefined);
  const result = writes.then(task, task);
  writes = result.catch(() => undefined);
  return result;
}

async function read(storageKey: string): Promise<TombstoneMap> {
  const result = await browser.storage.local.get(storageKey);
  const items = (result[storageKey] as TombstoneMap | undefined) ?? {};
  for (const item of Object.values(items)) item.accountStorageKey = storageKey;
  return items;
}

export const tombstoneRepository = {
  async list(requestedKey?: string): Promise<DeleteTombstone[]> {
    return Object.values(await read(requestedKey ?? await accountStorageKey(STORAGE_KEYS.tombstones)));
  },
  async has(id: string, requestedKey?: string): Promise<boolean> {
    return Boolean((await read(requestedKey ?? await accountStorageKey(STORAGE_KEYS.tombstones)))[id]);
  },
  async add(tombstone: DeleteTombstone): Promise<void> {
    const storageKey = tombstone.accountStorageKey ?? await accountStorageKey(STORAGE_KEYS.tombstones);
    await write(storageKey, async () => {
      const items = await read(storageKey);
      items[tombstone.workspaceId] = tombstone;
      await browser.storage.local.set({ [storageKey]: items });
    });
  },
  async remove(id: string, requestedKey?: string): Promise<void> {
    const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.tombstones);
    await write(storageKey, async () => {
      const items = await read(storageKey);
      delete items[id];
      await browser.storage.local.set({ [storageKey]: items });
    });
  },
};
