export const LOCAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SYNC_ALARM = 'windowstash-sync';
export const CLEANUP_ALARM = 'windowstash-cleanup';

export const STORAGE_KEYS = {
  supabaseConfig: 'supabaseConfig',
  workspaces: 'workspaces',
  syncLogs: 'syncLogs',
  tombstones: 'deleteTombstones',
  windowBindings: 'windowBindings',
  lazyRestoreEntries: 'lazyRestoreEntries',
} as const;

export function nextLocalExpiry(now = new Date()): string {
  return new Date(now.getTime() + LOCAL_RETENTION_MS).toISOString();
}
