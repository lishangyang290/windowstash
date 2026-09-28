import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';
import type { SyncLogEntry } from '@/types/workspace';

export const syncLogRepository = {
  async list(): Promise<SyncLogEntry[]> {
    const result = await browser.storage.local.get(STORAGE_KEYS.syncLogs);
    return (result[STORAGE_KEYS.syncLogs] as SyncLogEntry[] | undefined) ?? [];
  },

  async add(entry: Omit<SyncLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const logs = await this.list();
    logs.unshift({ ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString() });
    await browser.storage.local.set({ [STORAGE_KEYS.syncLogs]: logs.slice(0, 100) });
  },

  async clear(): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEYS.syncLogs]: [] });
  },
};
