import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';
import type { DeleteTombstone } from '@/types/workspace';

type TombstoneMap = Record<string, DeleteTombstone>;

async function read(): Promise<TombstoneMap> {
  const result = await browser.storage.local.get(STORAGE_KEYS.tombstones);
  return (result[STORAGE_KEYS.tombstones] as TombstoneMap | undefined) ?? {};
}

export const tombstoneRepository = {
  async list(): Promise<DeleteTombstone[]> {
    return Object.values(await read());
  },
  async has(id: string): Promise<boolean> {
    return Boolean((await read())[id]);
  },
  async add(tombstone: DeleteTombstone): Promise<void> {
    const items = await read();
    items[tombstone.workspaceId] = tombstone;
    await browser.storage.local.set({ [STORAGE_KEYS.tombstones]: items });
  },
  async remove(id: string): Promise<void> {
    const items = await read();
    delete items[id];
    await browser.storage.local.set({ [STORAGE_KEYS.tombstones]: items });
  },
};
