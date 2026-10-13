import { accountStorageKey } from './accountScope';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';
import { measurePopupStage } from '@/lib/popupPerformance';

export interface LazyRestoreEntry {
  accountStorageKey?: string;
  id: string;
  workspaceId: string;
  originalUrl: string;
  title: string;
  favIconUrl: string;
  position: number;
  pinned: boolean;
  createdAt: string;
  tabId?: number;
  windowId?: number;
  missingSince?: string;
  missingCount?: number;
}

type EntryMap = Record<string, LazyRestoreEntry>;

async function readMap(storageKey: string): Promise<EntryMap> {
  const result = await measurePopupStage('lazy-storage', () => browser.storage.local.get(storageKey));
  const entries = (result[storageKey] as EntryMap | undefined) ?? {};
  for (const entry of Object.values(entries)) entry.accountStorageKey = storageKey;
  return entries;
}

async function writeMap(entries: EntryMap, storageKey: string): Promise<void> {
  await browser.storage.local.set({ [storageKey]: entries });
}

let mutationQueue: Promise<void> = Promise.resolve();

async function mutate<T>(task: (storageKey: string) => Promise<T>, requestedKey?: string): Promise<T> {
  const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.lazyRestoreEntries);
  const operation = async (): Promise<T> => globalThis.navigator?.locks
    ? await navigator.locks.request('windowstash-lazy-records', () => task(storageKey))
    : task(storageKey);
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readSettledMap(requestedKey?: string): Promise<EntryMap> {
  const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.lazyRestoreEntries);
  await mutationQueue;
  return readMap(storageKey);
}

export const lazyRestoreRepository = {
  async list(requestedKey?: string): Promise<LazyRestoreEntry[]> {
    return Object.values(await readSettledMap(requestedKey));
  },

  async get(id: string): Promise<LazyRestoreEntry | null> {
    return (await readSettledMap())[id] ?? null;
  },

  async put(entry: LazyRestoreEntry): Promise<void> {
    await mutate(async (storageKey) => {
      if (entry.accountStorageKey && entry.accountStorageKey !== storageKey) throw new Error('恢复记录账号不一致');
      const entries = await readMap(storageKey);
      const activeEntry = { ...entry };
      delete activeEntry.missingSince;
      delete activeEntry.missingCount;
      entries[entry.id] = activeEntry;
      await writeMap(entries, storageKey);
    }, entry.accountStorageKey);
  },

  async remove(id: string, requestedKey?: string): Promise<void> {
    await mutate(async (storageKey) => {
      const entries = await readMap(storageKey);
      delete entries[id];
      await writeMap(entries, storageKey);
    }, requestedKey);
  },

  async removeByTabId(tabId: number): Promise<void> {
    await mutate(async (storageKey) => {
      const entries = await readMap(storageKey);
      const match = Object.values(entries).find((entry) => entry.tabId === tabId);
      if (!match) return;
      delete entries[match.id];
      await writeMap(entries, storageKey);
    });
  },

  async removeByWindowId(windowId: number): Promise<void> {
    await mutate(async (storageKey) => {
      const entries = await readMap(storageKey);
      const matches = Object.values(entries).filter((entry) => entry.windowId === windowId);
      if (!matches.length) return;
      for (const entry of matches) delete entries[entry.id];
      await writeMap(entries, storageKey);
    });
  },

  async removeMany(ids: string[], requestedKey?: string): Promise<void> {
    if (!ids.length) return;
    await mutate(async (storageKey) => {
      const entries = await readMap(storageKey);
      for (const id of ids) delete entries[id];
      await writeMap(entries, storageKey);
    }, requestedKey);
  },

  async recordPresence(liveIds: Set<string>, now: number): Promise<string[]> {
    return mutate(async (storageKey) => {
      const entries = await readMap(storageKey);
      const candidates: string[] = [];
      for (const entry of Object.values(entries)) {
        if (liveIds.has(entry.id)) {
          delete entry.missingSince;
          delete entry.missingCount;
          continue;
        }
        entry.missingSince ??= new Date(now).toISOString();
        entry.missingCount = (entry.missingCount ?? 0) + 1;
        if (entry.missingCount >= 2) candidates.push(entry.id);
      }
      await writeMap(entries, storageKey);
      return candidates;
    });
  },

  async removeConfirmedMissing(ids: string[], liveIds: Set<string>, now: number, graceMs: number): Promise<void> {
    if (!ids.length) return;
    await mutate(async (storageKey) => {
      const entries = await readMap(storageKey);
      let changed = false;
      for (const id of ids) {
        const entry = entries[id];
        if (!entry) continue;
        if (liveIds.has(id)) {
          delete entry.missingSince;
          delete entry.missingCount;
          changed = true;
          continue;
        }
        if (!entry.missingSince || (entry.missingCount ?? 0) < 2) continue;
        if (now - new Date(entry.missingSince).getTime() < graceMs) continue;
        delete entries[id];
        changed = true;
      }
      if (changed) await writeMap(entries, storageKey);
    });
  },
};
