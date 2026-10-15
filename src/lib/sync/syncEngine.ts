import { browser } from 'wxt/browser';
import { accountStorageKey } from '@/lib/storage/accountScope';
import type { WorkspaceLocalRecord } from '@/types/workspace';
import { nextLocalExpiry, STORAGE_KEYS } from '@/lib/constants';
import { cloudRowToLocal } from '@/lib/converters';
import { contentHash } from '@/lib/hash';
import { canCleanLocalCopy, decideSync } from '@/lib/syncRules';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import { tombstoneRepository } from '@/lib/storage/tombstoneRepository';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { workspaceRemoteRepository } from '@/lib/supabase/workspaceRemoteRepository';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { syncNative, resolveNativeConflict } from './nativeSync';

const syncTasks = new Map<string, Promise<unknown>>();
function serializeSync<T>(scope: string, id: string, task: () => Promise<T>): Promise<T> {
  const key = `windowstash-sync:${scope}:${id}`;
  if (globalThis.navigator?.locks) return navigator.locks.request(key, task).then((result) => result);
  const result = (syncTasks.get(key) ?? Promise.resolve()).then(task, task);
  syncTasks.set(key, result);
  void result.finally(() => { if (syncTasks.get(key) === result) syncTasks.delete(key); }).catch(() => undefined);
  return result;
}

async function log(
  workspaceId: string | null,
  workspaceName: string,
  action: string,
  result: 'success' | 'failed' | 'info',
  message: string,
  storageKey?: string,
) {
  void syncLogRepository.add({ workspaceId, workspaceName, action, result, message }, storageKey?.replace(/^workspaces/, STORAGE_KEYS.syncLogs));
}

async function markFailed(workspaceId: string, error: unknown, storageKey: string): Promise<void> {
  const record = await workspaceRepository.get(workspaceId, storageKey);
  if (!record) return;
  const message = error instanceof Error ? error.message : '未知同步错误';
  await workspaceRepository.put({
    ...record,
    sync: { ...record.sync, syncStatus: 'failed', lastSyncError: message },
  });
  await log(workspaceId, record.content.name, 'cloud-sync', 'failed', message, storageKey);
}

async function upload(record: WorkspaceLocalRecord): Promise<void> {
  const workspaceId = record.content.id;
  const hash = await contentHash(record.content);
  const row = await workspaceRemoteRepository.upsert(record.content, hash, ...(record.accountStorageKey ? [record.accountStorageKey] : []));
  const latest = await workspaceRepository.get(workspaceId, record.accountStorageKey);
  if (!latest || await contentHash(latest.content) !== hash) return;
  await workspaceRepository.put({
    ...(record.accountStorageKey ? { accountStorageKey: record.accountStorageKey } : {}),
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
  await log(workspaceId, record.content.name, 'cloud-sync', 'success', 'Cloud sync success', record.accountStorageKey);
}

export const syncEngine = {
  async syncWorkspace(workspaceId: string, requestedKey?: string): Promise<void> {
    const nativeScope = requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    if (await syncNative(nativeScope)) return;
    if (!(await workspaceRemoteRepository.isAuthenticated())) return;
    const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    return serializeSync(storageKey, workspaceId, async () => {
      if (await tombstoneRepository.has(workspaceId, storageKey.replace(/^workspaces/, STORAGE_KEYS.tombstones))) return;
      const local = await workspaceRepository.get(workspaceId, storageKey);
      if (!local) return;
      try {
        const cloud = await workspaceRemoteRepository.get(workspaceId, storageKey);
        if (!cloud) {
          if (local.sync.lastSyncedHash || local.sync.lastSyncedCloudUpdatedAt) {
            await workspaceRepository.put({ ...local, sync: { ...local.sync, syncStatus: 'conflict', lastSyncError: '云端记录缺失，本机副本已保留，禁止自动重新上传' } });
            return;
          }
          return await upload(local);
        }
        if (local.accountStorageKey !== cloud.accountStorageKey) return;
        const localHash = await contentHash(local.content);
        const latest = await workspaceRepository.get(workspaceId, storageKey);
        if (!latest || await contentHash(latest.content) !== localHash || await tombstoneRepository.has(workspaceId, storageKey.replace(/^workspaces/, STORAGE_KEYS.tombstones))) return;
        const decision = decideSync(local, localHash, cloud.content_hash, cloud.updated_at);
        if (decision === 'conflict') {
          await workspaceRepository.put({
            ...local,
            sync: { ...local.sync, syncStatus: 'conflict', lastSyncError: '本机与云端均有更新' },
          });
          await log(workspaceId, local.content.name, 'cloud-sync', 'failed', 'Conflict detected', storageKey);
        } else if (decision === 'upload') {
          await upload(local);
        } else if (decision === 'download') {
          await workspaceRepository.put(cloudRowToLocal(cloud));
          await log(workspaceId, cloud.name, 'cloud-sync', 'success', 'Cloud changes downloaded', storageKey);
        } else if (local.sync.syncStatus !== 'synced') {
          await workspaceRepository.put(cloudRowToLocal(cloud));
        }
      } catch (error) {
        await markFailed(workspaceId, error, storageKey);
      }
    });
  },

  async syncAll(requestedKey?: string): Promise<void> {
    const nativeScope = requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    if (await syncNative(nativeScope)) return;
    if (!(await workspaceRemoteRepository.isAuthenticated())) return;
    const storageKey = requestedKey ?? await accountStorageKey(STORAGE_KEYS.workspaces);
    const tombstoneKey = storageKey.replace(/^workspaces/, STORAGE_KEYS.tombstones);
    for (const tombstone of await tombstoneRepository.list(tombstoneKey)) {
      if (tombstone.cloudDeletedAt) continue;
      try {
        await serializeSync(storageKey, tombstone.workspaceId, async () => {
          await workspaceRemoteRepository.remove(tombstone.workspaceId, ...(tombstone.accountStorageKey ? [tombstone.accountStorageKey] : []));
          // Retain deletion evidence for stale window identities and delayed downloads.
          await tombstoneRepository.add({ ...tombstone, cloudDeletedAt: new Date().toISOString() });
          await log(tombstone.workspaceId, tombstone.workspaceName, 'cloud-delete', 'success', 'Cloud delete success', storageKey);
        });
      } catch (error) {
        await log(
          tombstone.workspaceId,
          tombstone.workspaceName,
          'cloud-delete',
          'failed',
          error instanceof Error ? error.message : 'Cloud delete failed',
          storageKey,
        );
      }
    }

    const localRecords = await workspaceRepository.list(storageKey);
    for (const record of localRecords) await this.syncWorkspace(record.content.id, storageKey);

    try {
      const remoteRows = await workspaceRemoteRepository.list(storageKey);
      for (const row of remoteRows) {
        if (!(await workspaceRepository.get(row.id, storageKey)) && !(await tombstoneRepository.has(row.id, tombstoneKey))) {
          await workspaceRepository.put(cloudRowToLocal(row));
        }
      }
    } catch (error) {
      await log(null, 'WindowStash', 'cloud-download', 'failed', error instanceof Error ? error.message : '下载失败', storageKey);
    }
  },

  async resolveConflict(workspaceId: string, choice: 'local' | 'cloud'): Promise<void> {
    const storageKey = await accountStorageKey(STORAGE_KEYS.workspaces);
    if (await resolveNativeConflict(storageKey, workspaceId, choice)) return;
    await serializeSync(storageKey, workspaceId, async () => {
      if (await tombstoneRepository.has(workspaceId, storageKey.replace(/^workspaces/, STORAGE_KEYS.tombstones))) return;
      const local = await workspaceRepository.get(workspaceId, storageKey);
      if (!local) return;
      if (choice === 'local') {
        await workspaceRepository.put({ ...local, sync: { ...local.sync, syncStatus: 'pending' } });
        await upload(local);
        return;
      }
      const cloud = await workspaceRemoteRepository.get(workspaceId, storageKey);
      if (!cloud) throw new Error('云端工作区不存在');
      await workspaceRepository.put(cloudRowToLocal(cloud));
    });
  },

  async cleanupExpiredLocalCopies(now = new Date()): Promise<number> {
    let removed = 0;
    const windows = await browser.windows.getAll();
    const activeWorkspaceIds = new Set((await Promise.all(windows.flatMap((window) => window.id == null
      ? []
      : [bindingRepository.get(window.id)]))).filter((id): id is string => id != null));
    for (const record of await workspaceRepository.list()) {
      if (!activeWorkspaceIds.has(record.content.id) && canCleanLocalCopy(record.sync.syncStatus, record.sync.localExpiresAt, now)) {
        if (record.accountStorageKey && record.accountStorageKey !== await accountStorageKey(STORAGE_KEYS.workspaces)) break;
        await workspaceRepository.remove(record.content.id, record.accountStorageKey);
        removed += 1;
      }
    }
    return removed;
  },
};
