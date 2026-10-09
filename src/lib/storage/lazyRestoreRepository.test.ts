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

    await expect(lazyRestoreRepository.get('legacy')).resolves.toEqual(entry('legacy', 7));
  });
});
