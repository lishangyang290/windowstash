import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';

export interface WindowAssociationTab {
  url: string;
  pinned: boolean;
  position: number;
}

export interface PersistentWindowAssociation {
  associationId: string;
  workspaceId: string;
  windowSnapshot: {
    tabs: WindowAssociationTab[];
    activeTabIndex: number;
  };
  lastObservedAt: string;
}

const prefix = STORAGE_KEYS.windowAssociationPrefix;
let writes = Promise.resolve();

function key(id: string): string {
  return `${prefix}${id}`;
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation, operation);
  writes = result.then(() => undefined, () => undefined);
  return result;
}

async function list(): Promise<PersistentWindowAssociation[]> {
  const values = await browser.storage.local.get(null);
  return Object.entries(values)
    .filter(([storageKey]) => storageKey.startsWith(prefix))
    .map(([, value]) => value as PersistentWindowAssociation)
    .filter((value) => value?.associationId && value.workspaceId && value.windowSnapshot?.tabs);
}

export const windowAssociationRepository = {
  list,

  upsert(
    workspaceId: string,
    windowSnapshot: PersistentWindowAssociation['windowSnapshot'],
    now = new Date().toISOString(),
  ): Promise<{ record: PersistentWindowAssociation; created: boolean; changed: boolean }> {
    return serialize(async () => {
      const existing = (await list()).find((record) => record.workspaceId === workspaceId);
      if (existing && JSON.stringify(existing.windowSnapshot) === JSON.stringify(windowSnapshot)) {
        return { record: existing, created: false, changed: false };
      }
      const record: PersistentWindowAssociation = {
        associationId: existing?.associationId ?? crypto.randomUUID(),
        workspaceId,
        windowSnapshot,
        lastObservedAt: now,
      };
      await browser.storage.local.set({ [key(record.associationId)]: record });
      return { record, created: !existing, changed: true };
    });
  },

  removeForWorkspace(workspaceId: string): Promise<void> {
    return serialize(async () => {
      const keys = (await list())
        .filter((record) => record.workspaceId === workspaceId)
        .map((record) => key(record.associationId));
      if (keys.length) await browser.storage.local.remove(keys);
    });
  },
};
