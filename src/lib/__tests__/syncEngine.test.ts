import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceLocalRecord } from '@/types/workspace';

const workspaceMock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), put: vi.fn(), remove: vi.fn() }));
const remoteMock = vi.hoisted(() => ({ isAuthenticated: vi.fn(), get: vi.fn(), upsert: vi.fn(), list: vi.fn(), remove: vi.fn() }));
const tombstoneMock = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), has: vi.fn() }));
const logMock = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@/lib/storage/workspaceRepository', () => ({ workspaceRepository: workspaceMock }));
vi.mock('@/lib/supabase/workspaceRemoteRepository', () => ({ workspaceRemoteRepository: remoteMock }));
vi.mock('@/lib/storage/tombstoneRepository', () => ({ tombstoneRepository: tombstoneMock }));
vi.mock('@/lib/storage/syncLogRepository', () => ({ syncLogRepository: logMock }));

import { syncEngine } from '@/lib/sync/syncEngine';

function record(id: string, syncStatus: 'pending' | 'failed'): WorkspaceLocalRecord {
  return {
    content: {
      id,
      name: `Workspace ${id}`,
      status: 'active',
      tabs: [{ title: id, url: `https://${id}.example`, position: 0, pinned: false }],
      activeTabIndex: 0,
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
    },
    sync: {
      syncStatus,
      lastSyncedAt: null,
      lastSyncedHash: null,
      lastSyncedCloudUpdatedAt: null,
      localExpiresAt: '2026-10-24T00:00:00.000Z',
      lastSyncError: syncStatus === 'failed' ? 'Previous failure' : null,
    },
  };
}

describe('syncEngine.syncAll', () => {
  const records = new Map<string, WorkspaceLocalRecord>();

  beforeEach(() => {
    vi.clearAllMocks();
    records.clear();
    remoteMock.isAuthenticated.mockResolvedValue(true);
    remoteMock.get.mockResolvedValue(null);
    remoteMock.list.mockResolvedValue([]);
    tombstoneMock.list.mockResolvedValue([]);
    logMock.add.mockResolvedValue(undefined);
    workspaceMock.get.mockImplementation(async (id: string) => records.get(id) ?? null);
    workspaceMock.put.mockImplementation(async (next: WorkspaceLocalRecord) => { records.set(next.content.id, next); });
    workspaceMock.list.mockImplementation(async () => [...records.values()]);
    remoteMock.upsert.mockImplementation(async (content: WorkspaceLocalRecord['content'], hash: string) => ({
      id: content.id,
      user_id: 'user-1',
      name: content.name,
      status: content.status,
      tabs: content.tabs,
      active_tab_index: content.activeTabIndex,
      content_hash: hash,
      created_at: content.createdAt,
      updated_at: '2026-09-24T01:00:00.000Z',
    }));
  });

  it('uploads every pending and failed workspace in one run', async () => {
    records.set('one', record('one', 'pending'));
    records.set('two', record('two', 'failed'));

    await syncEngine.syncAll();

    expect(remoteMock.upsert).toHaveBeenCalledTimes(2);
    expect([...records.values()].map(({ sync }) => sync.syncStatus)).toEqual(['synced', 'synced']);
  });

  it('keeps local data and marks the workspace failed when upload fails', async () => {
    records.set('one', record('one', 'pending'));
    remoteMock.upsert.mockRejectedValueOnce(new Error('Permission denied'));

    await syncEngine.syncAll();

    expect(records.get('one')?.content.tabs).toHaveLength(1);
    expect(records.get('one')?.sync.syncStatus).toBe('failed');
  });

  it('uploads an offline local rename when connectivity returns', async () => {
    const renamed = record('one', 'pending');
    renamed.content.name = '离线重命名';
    records.set('one', renamed);

    await syncEngine.syncAll();

    expect(remoteMock.upsert).toHaveBeenCalledWith(expect.objectContaining({ name: '离线重命名' }), expect.any(String));
    expect(records.get('one')?.sync.syncStatus).toBe('synced');
  });
});
