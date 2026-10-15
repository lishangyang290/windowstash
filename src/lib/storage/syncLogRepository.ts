import { syncTrace } from '../../../shared/syncDiagnostics';
import { accountStorageKey } from './accountScope';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';
import type { SyncLogEntry } from '@/types/workspace';

let writes = Promise.resolve();
const actions = new Set(['local-save', 'local-update', 'local-delete', 'cloud-sync', 'cloud-delete', 'cloud-download', 'window-association', 'launch']);
export const syncLogRepository = {
  async list(): Promise<SyncLogEntry[]> {
    await writes;
    const storageKey = await accountStorageKey(STORAGE_KEYS.syncLogs);
    const result = await browser.storage.local.get(storageKey);
    return (result[storageKey] as SyncLogEntry[] | undefined) ?? [];
  },

  async add(entry: Omit<SyncLogEntry, 'id' | 'timestamp'>, requestedKey?: string): Promise<void> {
    const key = requestedKey ? Promise.resolve(requestedKey) : accountStorageKey(STORAGE_KEYS.syncLogs);
    syncTrace(entry.result === 'failed' ? 'sync.failed' : 'sync.done', { scope: requestedKey, workspace: entry.workspaceId ?? undefined,
      action: entry.action.includes('delete') ? 'delete' : entry.action.includes('update') ? 'update' : 'save', result: entry.result === 'failed' ? 'failed' : entry.result === 'success' ? 'success' : 'observed',
      source: 'src/lib/storage/syncLogRepository.ts:add' });
    // Compatibility storage for callers still using this facade; never stores names or raw errors.
    writes = writes.then(async () => {
      const storageKey = await key;
      const logs = ((await browser.storage.local.get(storageKey))[storageKey] as SyncLogEntry[] | undefined) ?? [];
      const safe = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), workspaceId: null,
        workspaceName: '', action: actions.has(entry.action) ? entry.action : 'operation', result: entry.result,
        message: entry.result === 'failed' ? '操作失败，详见诊断中心' : entry.result === 'success' ? '操作完成' : '状态记录' };
      await browser.storage.local.set({ [storageKey]: [safe, ...logs].slice(0, 100) });
    }).catch(() => {});
    await writes;
  },

  async clear(): Promise<void> {
    await browser.storage.local.set({ [await accountStorageKey(STORAGE_KEYS.syncLogs)]: [] });
  },
};
