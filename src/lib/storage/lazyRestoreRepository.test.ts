import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ values: {} as Record<string, unknown>, tick: 0 }));
const browserMock = vi.hoisted(() => ({
  storage: {
    local: {
      get: vi.fn(async (key: string) => {
        await Promise.resolve();
        return { [key]: structuredClone(storage.values[key]) };
      }),
      set: vi.fn(async (values: Record<string, unknown>) => {
        if (storage.tick++ % 3 === 0) await Promise.resolve();
        Object.assign(storage.values, structuredClone(values));
      }),
    },
  },
}));

vi.mock('wxt/browser', () => ({ browser: browserMock }));

import { lazyRestoreRepository, type LazyRestoreEntry } from './lazyRestoreRepository';

function entry(id: string, tabId?: number): LazyRestoreEntry {
  return {
    id,
    workspaceId: 'workspace-1',
    originalUrl: `https://example.com/${id}`,
    title: id,
    favIconUrl: 'https://example.com/favicon.ico',
    position: Number(id.replace(/\D/g, '')) || 0,
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    tabId,
  };
}

describe('lazyRestoreRepository', () => {
  beforeEach(() => {
    storage.values = {};
    storage.tick = 0;
    vi.clearAllMocks();
  });

  it('keeps all one hundred concurrent writes', async () => {
    await Promise.all(Array.from({ length: 100 }, (_, index) => lazyRestoreRepository.put(entry(`lazy-${index}`))));

    const entries = await lazyRestoreRepository.list();
    expect(entries).toHaveLength(100);
    expect(new Set(entries.map(({ id }) => id)).size).toBe(100);
  });

  it('persists a whole restore batch with one registry read and write, retaining unrelated entries', async () => {
    storage.values.lazyRestoreEntries = { unrelated: entry('unrelated') };
    await lazyRestoreRepository.putMany(Array.from({ length: 34 }, (_, i) => entry(`lazy-${i}`)), 'lazyRestoreEntries');
    expect(browserMock.storage.local.get).toHaveBeenCalledExactlyOnceWith('lazyRestoreEntries');
    expect(browserMock.storage.local.set).toHaveBeenCalledOnce();
    expect(Object.keys(storage.values.lazyRestoreEntries as object)).toHaveLength(35);
    for (let i = 0; i < 34; i++) await lazyRestoreRepository.bindTab(`lazy-${i}`, i + 100, 20, 'lazyRestoreEntries', true);
    expect(browserMock.storage.local.set).toHaveBeenCalledTimes(35);
    expect(browserMock.storage.local.get).toHaveBeenCalledTimes(35);
  });

  it('shares only in-flight reads and never returns a completed or pre-mutation snapshot', async () => {
    storage.values.lazyRestoreEntries = { a: entry('a'), b: entry('b') };
    await Promise.all([lazyRestoreRepository.list('lazyRestoreEntries'), lazyRestoreRepository.list('lazyRestoreEntries')]);
    expect(browserMock.storage.local.get).toHaveBeenCalledExactlyOnceWith('lazyRestoreEntries');
    await lazyRestoreRepository.remove('a', 'lazyRestoreEntries');
    expect((await lazyRestoreRepository.list('lazyRestoreEntries')).map(e => e.id)).toEqual(['b']);
  });

  it('does not share a read across an intervening queued write', async () => {
    storage.values.lazyRestoreEntries = { a: entry('a') };
    const oldRead = lazyRestoreRepository.list('lazyRestoreEntries');
    const write = lazyRestoreRepository.putMany([entry('b')], 'lazyRestoreEntries');
    const newRead = lazyRestoreRepository.list('lazyRestoreEntries');
    await Promise.all([oldRead, write]);
    expect((await newRead).map(e => e.id)).toEqual(['a', 'b']);
  });

  it('keeps concurrent restore batches and reads isolated by account', async () => {
    const a = 'lazyRestoreEntries:A', b = 'lazyRestoreEntries:B';
    await Promise.all([
      lazyRestoreRepository.putMany([{ ...entry('same'), accountStorageKey: a }], a),
      lazyRestoreRepository.putMany([{ ...entry('same'), originalUrl: 'https://b.test', accountStorageKey: b }], b),
    ]);
    const [first, second] = await Promise.all([lazyRestoreRepository.list(a), lazyRestoreRepository.list(b)]);
    expect(first[0]!.originalUrl).toBe('https://example.com/same');
    expect(second[0]!.originalUrl).toBe('https://b.test');
    await expect(lazyRestoreRepository.putMany([{ ...entry('wrong'), accountStorageKey: b }], a)).rejects.toThrow('恢复记录账号不一致');
    expect(await lazyRestoreRepository.list(a)).toHaveLength(1);
  });

  it('writes once when creation and event listeners claim the same tab concurrently', async () => {
    await lazyRestoreRepository.putMany([entry('a')], 'lazyRestoreEntries');
    browserMock.storage.local.set.mockClear();
    await Promise.all(Array.from({ length: 4 }, () => lazyRestoreRepository.bindTab('a', 10, 20, 'lazyRestoreEntries')));
    expect(browserMock.storage.local.set).toHaveBeenCalledOnce();
    expect(await lazyRestoreRepository.get('a')).toEqual(expect.objectContaining({ tabId: 10, windowId: 20 }));
  });

  it('cannot resurrect a closed or activated-and-navigated tab with a delayed creation update', async () => {
    await lazyRestoreRepository.putMany([entry('a'), entry('b')], 'lazyRestoreEntries');
    await lazyRestoreRepository.remove('a', 'lazyRestoreEntries');
    await expect(lazyRestoreRepository.bindTab('a', 10, 20, 'lazyRestoreEntries', true)).resolves.toBeNull();
    await lazyRestoreRepository.bindTab('b', 11, 30, 'lazyRestoreEntries');
    await lazyRestoreRepository.bindTab('b', 11, 20, 'lazyRestoreEntries', true);
    expect(await lazyRestoreRepository.get('b')).toEqual(expect.objectContaining({ windowId: 30 }));
    expect(await lazyRestoreRepository.get('a')).toBeNull();
  });

  it('retains the durable original URL when tab-id persistence fails', async () => {
    await lazyRestoreRepository.putMany([entry('a')], 'lazyRestoreEntries');
    browserMock.storage.local.set.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(lazyRestoreRepository.bindTab('a', 10, 20, 'lazyRestoreEntries')).rejects.toThrow('storage unavailable');
    expect(await lazyRestoreRepository.get('a')).toEqual(expect.objectContaining({ originalUrl: 'https://example.com/a' }));
    await lazyRestoreRepository.bindTab('a', 10, 20, 'lazyRestoreEntries');
    expect(await lazyRestoreRepository.get('a')).toEqual(expect.objectContaining({ tabId: 10 }));
  });

  it('serializes put and remove without losing unrelated records', async () => {
    await Promise.all([
      lazyRestoreRepository.put(entry('lazy-1', 1)),
      lazyRestoreRepository.put(entry('lazy-2', 2)),
    ]);

    await Promise.all([
      lazyRestoreRepository.remove('lazy-1'),
      lazyRestoreRepository.put(entry('lazy-3', 3)),
      lazyRestoreRepository.put({ ...entry('lazy-2', 22), title: 'updated' }),
    ]);

    expect(await lazyRestoreRepository.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lazy-2', tabId: 22, title: 'updated' }),
      expect.objectContaining({ id: 'lazy-3', tabId: 3 }),
    ]));
    expect(await lazyRestoreRepository.get('lazy-1')).toBeNull();
  });

  it('serializes every removal variant with writes', async () => {
    await lazyRestoreRepository.put({ ...entry('lazy-1', 1), windowId: 10 });
    await lazyRestoreRepository.put({ ...entry('lazy-2', 2), windowId: 20 });
    await lazyRestoreRepository.put({ ...entry('lazy-3', 3), windowId: 30 });

    await Promise.all([
      lazyRestoreRepository.removeByTabId(1),
      lazyRestoreRepository.removeByWindowId(20),
      lazyRestoreRepository.removeMany(['lazy-3']),
      lazyRestoreRepository.put(entry('lazy-4', 4)),
    ]);

    expect((await lazyRestoreRepository.list()).map(({ id }) => id)).toEqual(['lazy-4']);
  });

  it('requires repeated absence and rechecks presence before deletion', async () => {
    await lazyRestoreRepository.put(entry('lazy-1', 1));
    const startedAt = new Date('2026-10-09T00:00:00.000Z').getTime();

    expect(await lazyRestoreRepository.recordPresence(new Set(), startedAt)).toEqual([]);
    const candidates = await lazyRestoreRepository.recordPresence(new Set(), startedAt + 10 * 60 * 1000);
    expect(candidates).toEqual(['lazy-1']);

    await lazyRestoreRepository.removeConfirmedMissing(
      candidates,
      new Set(['lazy-1']),
      startedAt + 10 * 60 * 1000,
      5 * 60 * 1000,
    );
    expect(await lazyRestoreRepository.get('lazy-1')).toEqual(expect.not.objectContaining({
      missingSince: expect.anything(),
      missingCount: expect.anything(),
    }));
  });

  it('reads v0.3.0 map entries without cleanup metadata', async () => {
    storage.values.lazyRestoreEntries = { legacy: entry('legacy', 7) };

    await expect(lazyRestoreRepository.get('legacy')).resolves.toEqual({ ...entry('legacy', 7), accountStorageKey: 'lazyRestoreEntries' });
  });
});
