import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';

export interface LazyRestoreEntry {
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

async function readMap(): Promise<EntryMap> {
  const result = await browser.storage.local.get(STORAGE_KEYS.lazyRestoreEntries);
  return (result[STORAGE_KEYS.lazyRestoreEntries] as EntryMap | undefined) ?? {};
}

async function writeMap(entries: EntryMap): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.lazyRestoreEntries]: entries });
}

let mutationQueue: Promise<void> = Promise.resolve();

function mutate<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readSettledMap(): Promise<EntryMap> {
  await mutationQueue;
  return readMap();
}

export const lazyRestoreRepository = {
  async list(): Promise<LazyRestoreEntry[]> {
    return Object.values(await readSettledMap());
  },

  async get(id: string): Promise<LazyRestoreEntry | null> {
    return (await readSettledMap())[id] ?? null;
  },

  async put(entry: LazyRestoreEntry): Promise<void> {
    await mutate(async () => {
      const entries = await readMap();
      const activeEntry = { ...entry };
      delete activeEntry.missingSince;
      delete activeEntry.missingCount;
      entries[entry.id] = activeEntry;
      await writeMap(entries);
    });
  },

  async remove(id: string): Promise<void> {
    await mutate(async () => {
      const entries = await readMap();
      delete entries[id];
      await writeMap(entries);
    });
  },

  async removeByTabId(tabId: number): Promise<void> {
    await mutate(async () => {
      const entries = await readMap();
      const match = Object.values(entries).find((entry) => entry.tabId === tabId);
      if (!match) return;
      delete entries[match.id];
      await writeMap(entries);
    });
  },

  async removeByWindowId(windowId: number): Promise<void> {
    await mutate(async () => {
      const entries = await readMap();
      const matches = Object.values(entries).filter((entry) => entry.windowId === windowId);
      if (!matches.length) return;
      for (const entry of matches) delete entries[entry.id];
      await writeMap(entries);
    });
  },

  async removeMany(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await mutate(async () => {
      const entries = await readMap();
      for (const id of ids) delete entries[id];
      await writeMap(entries);
    });
  },

  async recordPresence(liveIds: Set<string>, now: number): Promise<string[]> {
    return mutate(async () => {
      const entries = await readMap();
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
      await writeMap(entries);
      return candidates;
    });
  },

  async removeConfirmedMissing(ids: string[], liveIds: Set<string>, now: number, graceMs: number): Promise<void> {
    if (!ids.length) return;
    await mutate(async () => {
      const entries = await readMap();
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
      if (changed) await writeMap(entries);
    });
  },
};
