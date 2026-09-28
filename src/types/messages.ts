export type BackgroundMessage =
  | { type: 'SYNC_ALL' }
  | { type: 'SYNC_WORKSPACE'; workspaceId: string }
  | { type: 'CLEANUP_LOCAL' };
