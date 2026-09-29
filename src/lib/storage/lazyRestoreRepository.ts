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
}

type EntryMap = Record<string, LazyRestoreEntry>;

async function readMap(): Promise<EntryMap> {
  const result = await browser.storage.local.get(STORAGE_KEYS.lazyRestoreEntries);
  return (result[STORAGE_KEYS.lazyRestoreEntries] as EntryMap | undefined) ?? {};
}

async function writeMap(entries: EntryMap): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.lazyRestoreEntries]: entries });
}

export const lazyRestoreRepository = {
  async list(): Promise<LazyRestoreEntry[]> {
    return Object.values(await readMap());
  },

  async get(id: string): Promise<LazyRestoreEntry | null> {
    return (await readMap())[id] ?? null;
  },

  async put(entry: LazyRestoreEntry): Promise<void> {
    const entries = await readMap();
    entries[entry.id] = entry;
    await writeMap(entries);
  },

  async remove(id: string): Promise<void> {
    const entries = await readMap();
    delete entries[id];
    await writeMap(entries);
  },

  async removeByTabId(tabId: number): Promise<void> {
    const entries = await readMap();
    const match = Object.values(entries).find((entry) => entry.tabId === tabId);
    if (!match) return;
    delete entries[match.id];
    await writeMap(entries);
  },

  async removeByWindowId(windowId: number): Promise<void> {
    const entries = await readMap();
    const matches = Object.values(entries).filter((entry) => entry.windowId === windowId);
    if (!matches.length) return;
    for (const entry of matches) delete entries[entry.id];
    await writeMap(entries);
  },

  async removeMany(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const entries = await readMap();
    for (const id of ids) delete entries[id];
    await writeMap(entries);
  },
};
