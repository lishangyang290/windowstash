export type BackgroundMessage =
  | { type: 'SYNC_ALL' }
  | { type: 'SYNC_WORKSPACE'; workspaceId: string }
  | { type: 'CLEANUP_LOCAL' }
  | { type: 'OPEN_OR_FOCUS_WORKSPACE'; workspaceId: string };
