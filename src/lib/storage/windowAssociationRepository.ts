import { accountStorageKey } from './accountScope';
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

function key(id: string, storagePrefix: string): string {
  return `${storagePrefix}${id}`;
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation, operation);
  writes = result.then(() => undefined, () => undefined);
  return result;
}

async function list(storagePrefix?: string): Promise<PersistentWindowAssociation[]> {
  storagePrefix ??= await scopedPrefix();
  const values = await browser.storage.local.get(null);
  return Object.entries(values)
    .filter(([storageKey]) => storageKey.startsWith(storagePrefix!) && (storagePrefix !== prefix || !storageKey.startsWith(`${prefix}:`)))
    .map(([, value]) => value as PersistentWindowAssociation)
    .filter((value) => value?.associationId && value.workspaceId && value.windowSnapshot?.tabs);
}

async function scopedPrefix(requestedKey?: string) {
  if (requestedKey) return requestedKey === 'workspaces' ? prefix : `${requestedKey.replace(/^workspaces/, prefix)}:`;
  const value = await accountStorageKey(prefix);
  return value === prefix ? prefix : `${value}:`;
}

export const windowAssociationRepository = {
  list,

  async upsert(
    workspaceId: string,
    windowSnapshot: PersistentWindowAssociation['windowSnapshot'],
    now = new Date().toISOString(),
    requestedKey?: string,
  ): Promise<{ record: PersistentWindowAssociation; created: boolean; changed: boolean }> {
    const storagePrefix = await scopedPrefix(requestedKey);
    return serialize(async () => {
      const existing = (await list(storagePrefix)).find((record) => record.workspaceId === workspaceId);
      if (existing && JSON.stringify(existing.windowSnapshot) === JSON.stringify(windowSnapshot)) {
        return { record: existing, created: false, changed: false };
      }
      const record: PersistentWindowAssociation = {
        associationId: existing?.associationId ?? crypto.randomUUID(),
        workspaceId,
        windowSnapshot,
        lastObservedAt: now,
      };
      await browser.storage.local.set({ [key(record.associationId, storagePrefix)]: record });
      return { record, created: !existing, changed: true };
    });
  },

  async removeForWorkspace(workspaceId: string, requestedKey?: string): Promise<void> {
    const storagePrefix = await scopedPrefix(requestedKey);
    return serialize(async () => {
      const keys = (await list(storagePrefix))
        .filter((record) => record.workspaceId === workspaceId)
        .map((record) => key(record.associationId, storagePrefix));
      if (keys.length) await browser.storage.local.remove(keys);
    });
  },
};
