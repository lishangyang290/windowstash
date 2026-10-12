import { accountStorageKey } from './accountScope';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';
import type { SyncLogEntry } from '@/types/workspace';

export const syncLogRepository = {
  async list(): Promise<SyncLogEntry[]> {
    const storageKey = await accountStorageKey(STORAGE_KEYS.syncLogs);
    const result = await browser.storage.local.get(storageKey);
    return (result[storageKey] as SyncLogEntry[] | undefined) ?? [];
  },

  async add(entry: Omit<SyncLogEntry, 'id' | 'timestamp'>, requestedKey?: string): Promise<void> {
    const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.syncLogs);
    const logs = ((await browser.storage.local.get(storageKey))[storageKey] as SyncLogEntry[] | undefined) ?? [];
    logs.unshift({ ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString() });
    await browser.storage.local.set({ [storageKey]: logs.slice(0, 100) });
  },

  async clear(): Promise<void> {
    await browser.storage.local.set({ [await accountStorageKey(STORAGE_KEYS.syncLogs)]: [] });
  },
};
