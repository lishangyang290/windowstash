export type BackgroundMessage =
  | { type: 'SYNC_ALL' }
  | { type: 'SYNC_WORKSPACE'; workspaceId: string }
  | { type: 'CLEANUP_LOCAL' }
  | { type: 'OPEN_OR_FOCUS_WORKSPACE'; workspaceId: string }
  | { type: 'LAZY_TAB_READY'; lazyId: string }
  | { type: 'RESOLVE_LAZY_TAB'; lazyId: string }
  | { type: 'CLOSE_LAZY_TAB' };
