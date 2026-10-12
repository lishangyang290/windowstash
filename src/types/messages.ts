export type BackgroundMessage =
  | { type: 'SYNC_ALL'; accountStorageKey?: string }
  | { type: 'SYNC_WORKSPACE'; workspaceId: string; accountStorageKey?: string }
  | { type: 'CLEANUP_LOCAL' }
  | { type: 'OPEN_OR_FOCUS_WORKSPACE'; accountStorageKey?: string; workspaceId: string }
  | { type: 'REOPEN_WORKSPACE'; accountStorageKey?: string; workspaceId: string; sourceWindowId: number }
  | { type: 'RECOVER_WORKSPACE'; accountStorageKey?: string; workspaceId: string; sourceWindowId: number }
  | { type: 'RESTORE_SAVED_WORKSPACE'; accountStorageKey?: string; workspaceId: string }
  | { type: 'LAZY_TAB_READY'; lazyId: string }
  | { type: 'RESOLVE_LAZY_TAB'; lazyId: string }
  | { type: 'CLOSE_LAZY_TAB' };
