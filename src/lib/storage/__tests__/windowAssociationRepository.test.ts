import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => new Map<string, unknown>());
const localMock = vi.hoisted(() => ({
  get: vi.fn(async () => Object.fromEntries(values)),
  set: vi.fn(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) values.set(key, value);
  }),
  remove: vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
  }),
}));

vi.mock('wxt/browser', () => ({ browser: { storage: { local: localMock } } }));

import { windowAssociationRepository } from '../windowAssociationRepository';

describe('windowAssociationRepository', () => {
  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
  });

  it('serializes concurrent writes without losing different workspace associations', async () => {
    await Promise.all([
      windowAssociationRepository.upsert('workspace-a', { tabs: [{ url: 'https://a.example', pinned: false, position: 0 }], activeTabIndex: 0 }),
      windowAssociationRepository.upsert('workspace-b', { tabs: [{ url: 'https://b.example', pinned: true, position: 0 }], activeTabIndex: 0 }),
    ]);

    await expect(windowAssociationRepository.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceId: 'workspace-a' }),
      expect.objectContaining({ workspaceId: 'workspace-b' }),
    ]));
  });

  it('updates one stable association record instead of creating duplicates', async () => {
    const first = await windowAssociationRepository.upsert('workspace-a', { tabs: [{ url: 'https://a.example', pinned: false, position: 0 }], activeTabIndex: 0 });
    const second = await windowAssociationRepository.upsert('workspace-a', { tabs: [{ url: 'about:blank', pinned: false, position: 0 }], activeTabIndex: 0 });

    expect(second.record.associationId).toBe(first.record.associationId);
    await expect(windowAssociationRepository.list()).resolves.toHaveLength(1);
  });

  it('skips an unchanged snapshot instead of writing it again', async () => {
    const snapshot = { tabs: [{ url: 'https://same.example', pinned: false, position: 0 }], activeTabIndex: 0 };
    await windowAssociationRepository.upsert('workspace-a', snapshot);
    localMock.set.mockClear();

    await expect(windowAssociationRepository.upsert('workspace-a', snapshot)).resolves.toEqual(expect.objectContaining({ changed: false }));
    expect(localMock.set).not.toHaveBeenCalled();
  });
});
