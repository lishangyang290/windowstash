import { nextLocalExpiry } from '@/lib/constants';
import type { CloudWorkspaceRow, WorkspaceContent, WorkspaceLocalRecord } from '@/types/workspace';

export function cloudRowToLocal(row: CloudWorkspaceRow, now = new Date()): WorkspaceLocalRecord {
  const content: WorkspaceContent = {
    id: row.id,
    name: row.name,
    status: row.status,
    tabs: [...row.tabs].sort((a, b) => a.position - b.position),
    activeTabIndex: row.active_tab_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return {
    content,
    sync: {
      syncStatus: 'synced',
      lastSyncedAt: now.toISOString(),
      lastSyncedHash: row.content_hash,
      lastSyncedCloudUpdatedAt: row.updated_at,
      localExpiresAt: nextLocalExpiry(now),
      lastSyncError: null,
    },
  };
}
