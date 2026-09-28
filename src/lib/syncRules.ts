import type { SyncStatus, WorkspaceLocalRecord } from '@/types/workspace';

export type SyncDecision = 'upload' | 'download' | 'noop' | 'conflict';

export function decideSync(
  local: WorkspaceLocalRecord,
  localHash: string,
  cloudHash: string,
  cloudUpdatedAt: string,
): SyncDecision {
  const localChanged = localHash !== local.sync.lastSyncedHash;
  const cloudChanged = Boolean(
    local.sync.lastSyncedCloudUpdatedAt &&
      cloudUpdatedAt !== local.sync.lastSyncedCloudUpdatedAt &&
      cloudHash !== local.sync.lastSyncedHash,
  );

  if ((local.sync.syncStatus === 'pending' || local.sync.syncStatus === 'failed') && localChanged && cloudChanged) {
    return 'conflict';
  }
  if (localChanged) return 'upload';
  if (cloudChanged) return 'download';
  return 'noop';
}

export function canCleanLocalCopy(syncStatus: SyncStatus, localExpiresAt: string, now = new Date()): boolean {
  return syncStatus === 'synced' && new Date(localExpiresAt).getTime() <= now.getTime();
}
