import { accountStorageKey } from './accountScope';
import { browser } from 'wxt/browser';
import { nextLocalExpiry, STORAGE_KEYS } from '@/lib/constants';
import type { WorkspaceContent, WorkspaceLocalRecord } from '@/types/workspace';

type WorkspaceMap = Record<string, WorkspaceLocalRecord>;

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
  },

  async put(record: WorkspaceLocalRecord): Promise<void> {
    const storageKey = record.accountStorageKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    const records = await readMap(storageKey);
    records[record.content.id] = record;
    await writeMap(records, storageKey);
  },

  async remove(id: string, requestedKey?: string): Promise<void> {
    const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    const records = await readMap(storageKey);
    delete records[id];
    await writeMap(records, storageKey);
  },
};
