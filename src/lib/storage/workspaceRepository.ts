import { accountStorageKey } from './accountScope';
import { browser } from 'wxt/browser';
import { nextLocalExpiry, STORAGE_KEYS } from '@/lib/constants';
import type { WorkspaceContent, WorkspaceLocalRecord } from '@/types/workspace';
import { tombstoneRepository } from './tombstoneRepository';

type WorkspaceMap = Record<string, WorkspaceLocalRecord>;
let writes = Promise.resolve();
function write<T>(storageKey: string, task: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return navigator.locks.request(`windowstash-workspaces:${storageKey}`, task).then((result) => result);
  const result = writes.then(task, task);
  writes = result.then(() => undefined, () => undefined);
  return result;
}

async function readMap(storageKey = STORAGE_KEYS.workspaces as string): Promise<WorkspaceMap> {
  const result = await browser.storage.local.get(storageKey);
  const records = (result[storageKey] as WorkspaceMap | undefined) ?? {};
  for (const record of Object.values(records)) record.accountStorageKey = storageKey;
  return records;
}

async function writeMap(records: WorkspaceMap, storageKey: string): Promise<void> {
  await browser.storage.local.set({ [storageKey]: records });
}

export const workspaceRepository = {
  async list(requestedKey?: string): Promise<WorkspaceLocalRecord[]> {
    return Object.values(await readMap(requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces))).sort(
      (a, b) => new Date(b.content.updatedAt).getTime() - new Date(a.content.updatedAt).getTime(),
    );
  },

  async get(id: string, requestedKey?: string): Promise<WorkspaceLocalRecord | null> {
    return (await readMap(requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces)))[id] ?? null;
  },

  async saveContent(content: WorkspaceContent, requestedKey?: string): Promise<WorkspaceLocalRecord> {
    const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    return write(storageKey, async () => {
      if (await tombstoneRepository.has(content.id, storageKey.replace(/^workspaces/, STORAGE_KEYS.tombstones))) throw new Error('工作区已删除');
      const records = await readMap(storageKey);
      const previous = records[content.id];
      const record: WorkspaceLocalRecord = {
        accountStorageKey: storageKey,
        content,
        sync: {
          syncStatus: 'pending',
          lastSyncedAt: previous?.sync.lastSyncedAt ?? null,
          lastSyncedHash: previous?.sync.lastSyncedHash ?? null,
          lastSyncedCloudUpdatedAt: previous?.sync.lastSyncedCloudUpdatedAt ?? null,
          localExpiresAt: nextLocalExpiry(),
          lastSyncError: null,
        },
      };
      records[content.id] = record;
      await writeMap(records, storageKey);
      return record;
    });
  },

  async put(record: WorkspaceLocalRecord): Promise<void> {
    const storageKey = record.accountStorageKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    await write(storageKey, async () => {
      if (await tombstoneRepository.has(record.content.id, storageKey.replace(/^workspaces/, STORAGE_KEYS.tombstones))) return;
      const records = await readMap(storageKey);
      records[record.content.id] = record;
      await writeMap(records, storageKey);
    });
  },

  async remove(id: string, requestedKey?: string): Promise<void> {
    const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    await write(storageKey, async () => {
      const records = await readMap(storageKey);
      delete records[id];
      await writeMap(records, storageKey);
    });
  },
};
