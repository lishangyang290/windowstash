import { browser } from 'wxt/browser';
import { nextLocalExpiry, STORAGE_KEYS } from '@/lib/constants';
import type { WorkspaceContent, WorkspaceLocalRecord } from '@/types/workspace';

type WorkspaceMap = Record<string, WorkspaceLocalRecord>;

async function readMap(): Promise<WorkspaceMap> {
  const result = await browser.storage.local.get(STORAGE_KEYS.workspaces);
  return (result[STORAGE_KEYS.workspaces] as WorkspaceMap | undefined) ?? {};
}

async function writeMap(records: WorkspaceMap): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.workspaces]: records });
}

export const workspaceRepository = {
  async list(): Promise<WorkspaceLocalRecord[]> {
    return Object.values(await readMap()).sort(
      (a, b) => new Date(b.content.updatedAt).getTime() - new Date(a.content.updatedAt).getTime(),
    );
  },

  async get(id: string): Promise<WorkspaceLocalRecord | null> {
    return (await readMap())[id] ?? null;
  },

  async saveContent(content: WorkspaceContent): Promise<WorkspaceLocalRecord> {
    const records = await readMap();
    const previous = records[content.id];
    const record: WorkspaceLocalRecord = {
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
    await writeMap(records);
    return record;
  },

  async put(record: WorkspaceLocalRecord): Promise<void> {
    const records = await readMap();
    records[record.content.id] = record;
    await writeMap(records);
  },

  async remove(id: string): Promise<void> {
    const records = await readMap();
    delete records[id];
    await writeMap(records);
  },
};
