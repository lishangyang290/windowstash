export type WorkspaceStatus = 'active' | 'review' | 'revision' | 'archived';
export type SyncStatus = 'synced' | 'pending' | 'failed' | 'conflict';

export interface StoredTab {
  title: string;
  url: string;
  favIconUrl?: string;
  position: number;
  pinned: boolean;
}

export interface WorkspaceContent {
  id: string;
  name: string;
  status: WorkspaceStatus;
  tabs: StoredTab[];
  activeTabIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface SyncMetadata {
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  lastSyncedHash: string | null;
  lastSyncedCloudUpdatedAt: string | null;
  localExpiresAt: string;
  lastSyncError: string | null;
}

export interface WorkspaceLocalRecord {
  content: WorkspaceContent;
  sync: SyncMetadata;
}

export interface SyncLogEntry {
  id: string;
  workspaceId: string | null;
  workspaceName: string;
  timestamp: string;
  action: string;
  result: 'success' | 'failed' | 'info';
  message: string;
}

export interface DeleteTombstone {
  workspaceId: string;
  workspaceName: string;
  deletedAt: string;
}

export interface CloudWorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  status: WorkspaceStatus;
  tabs: StoredTab[];
  active_tab_index: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export const STATUS_LABELS: Record<WorkspaceStatus, string> = {
  active: '进行中',
  review: '待评审',
  revision: '待修改',
  archived: '已归档',
};

export const SYNC_LABELS: Record<SyncStatus, string> = {
  synced: '已同步',
  pending: '等待同步',
  failed: '同步失败',
  conflict: '同步冲突',
};
