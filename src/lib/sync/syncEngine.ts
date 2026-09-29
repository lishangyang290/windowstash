import { browser } from 'wxt/browser';
import { nextLocalExpiry } from '@/lib/constants';
import { cloudRowToLocal } from '@/lib/converters';
import { contentHash } from '@/lib/hash';
import { canCleanLocalCopy, decideSync } from '@/lib/syncRules';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import { tombstoneRepository } from '@/lib/storage/tombstoneRepository';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { workspaceRemoteRepository } from '@/lib/supabase/workspaceRemoteRepository';
import { bindingRepository } from '@/lib/storage/bindingRepository';

async function log(
  workspaceId: string | null,
  workspaceName: string,
  action: string,
  result: 'success' | 'failed' | 'info',
  message: string,
) {
  await syncLogRepository.add({ workspaceId, workspaceName, action, result, message });
}

async function markFailed(workspaceId: string, error: unknown): Promise<void> {
  const record = await workspaceRepository.get(workspaceId);
  if (!record) return;
  const message = error instanceof Error ? error.message : '未知同步错误';
  await workspaceRepository.put({
    ...record,
    sync: { ...record.sync, syncStatus: 'failed', lastSyncError: message },
  });
  await log(workspaceId, record.content.name, 'cloud-sync', 'failed', message);
}

async function upload(workspaceId: string): Promise<void> {
  const record = await workspaceRepository.get(workspaceId);
  if (!record) return;
  const hash = await contentHash(record.content);
  const row = await workspaceRemoteRepository.upsert(record.content, hash);
  await workspaceRepository.put({
    content: { ...record.content, updatedAt: row.updated_at },
    sync: {
      syncStatus: 'synced',
      lastSyncedAt: new Date().toISOString(),
      lastSyncedHash: hash,
      lastSyncedCloudUpdatedAt: row.updated_at,
      localExpiresAt: nextLocalExpiry(),
      lastSyncError: null,
    },
  });
  await log(workspaceId, record.content.name, 'cloud-sync', 'success', 'Cloud sync success');
}

export const syncEngine = {
  async syncWorkspace(workspaceId: string): Promise<void> {
    const local = await workspaceRepository.get(workspaceId);
    if (!local || !(await workspaceRemoteRepository.isAuthenticated())) return;
    try {
      const cloud = await workspaceRemoteRepository.get(workspaceId);
      if (!cloud) return await upload(workspaceId);
      const localHash = await contentHash(local.content);
      const decision = decideSync(local, localHash, cloud.content_hash, cloud.updated_at);
      if (decision === 'conflict') {
        await workspaceRepository.put({
          ...local,
          sync: { ...local.sync, syncStatus: 'conflict', lastSyncError: '本机与云端均有更新' },
        });
        await log(workspaceId, local.content.name, 'cloud-sync', 'failed', 'Conflict detected');
      } else if (decision === 'upload') {
        await upload(workspaceId);
      } else if (decision === 'download') {
        await workspaceRepository.put(cloudRowToLocal(cloud));
        await log(workspaceId, cloud.name, 'cloud-sync', 'success', 'Cloud changes downloaded');
      } else if (local.sync.syncStatus !== 'synced') {
        await workspaceRepository.put(cloudRowToLocal(cloud));
      }
    } catch (error) {
      await markFailed(workspaceId, error);
    }
  },

  async syncAll(): Promise<void> {
    if (!(await workspaceRemoteRepository.isAuthenticated())) return;
    for (const tombstone of await tombstoneRepository.list()) {
      try {
        await workspaceRemoteRepository.remove(tombstone.workspaceId);
        await tombstoneRepository.remove(tombstone.workspaceId);
        await log(tombstone.workspaceId, tombstone.workspaceName, 'cloud-delete', 'success', 'Cloud delete success');
      } catch (error) {
        await log(
          tombstone.workspaceId,
          tombstone.workspaceName,
          'cloud-delete',
          'failed',
          error instanceof Error ? error.message : 'Cloud delete failed',
        );
      }
    }

    const localRecords = await workspaceRepository.list();
    for (const record of localRecords) await this.syncWorkspace(record.content.id);

    try {
      const remoteRows = await workspaceRemoteRepository.list();
      for (const row of remoteRows) {
        if (!(await workspaceRepository.get(row.id)) && !(await tombstoneRepository.has(row.id))) {
          await workspaceRepository.put(cloudRowToLocal(row));
        }
      }
    } catch (error) {
      await log(null, 'WindowStash', 'cloud-download', 'failed', error instanceof Error ? error.message : '下载失败');
    }
  },

  async resolveConflict(workspaceId: string, choice: 'local' | 'cloud'): Promise<void> {
    const local = await workspaceRepository.get(workspaceId);
    if (!local) return;
    if (choice === 'local') {
      await workspaceRepository.put({ ...local, sync: { ...local.sync, syncStatus: 'pending' } });
      await upload(workspaceId);
      return;
    }
    const cloud = await workspaceRemoteRepository.get(workspaceId);
    if (!cloud) throw new Error('云端工作区不存在');
    await workspaceRepository.put(cloudRowToLocal(cloud));
  },

  async cleanupExpiredLocalCopies(now = new Date()): Promise<number> {
    let removed = 0;
    const windows = await browser.windows.getAll();
    const activeWorkspaceIds = new Set((await Promise.all(windows.flatMap((window) => window.id == null
      ? []
      : [bindingRepository.get(window.id)]))).filter((id): id is string => id != null));
    for (const record of await workspaceRepository.list()) {
      if (!activeWorkspaceIds.has(record.content.id) && canCleanLocalCopy(record.sync.syncStatus, record.sync.localExpiresAt, now)) {
        await workspaceRepository.remove(record.content.id);
        removed += 1;
      }
    }
    return removed;
  },
};
