import { browser } from 'wxt/browser';
import { accountStorageKey } from '@/lib/storage/accountScope';
import { STORAGE_KEYS } from '@/lib/constants';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { tombstoneRepository } from '@/lib/storage/tombstoneRepository';
import { syncEngine } from './syncEngine';
import { syncTrace } from '../../../shared/syncDiagnostics';

export const PENDING_SYNC_ALARM = 'windowstash-pending-sync';
export async function schedulePendingSync(delay = 1_000) {
  const schedule = async () => {
    const when = Date.now() + delay;
    const existing = await browser.alarms.get(PENDING_SYNC_ALARM);
    if (!existing || existing.scheduledTime > when) {
      await browser.alarms.create(PENDING_SYNC_ALARM, { when });
      syncTrace('sync.retry', { source: 'src/lib/sync/pendingSync.ts:schedulePendingSync', retryMs: delay });
    }
  };
  if (globalThis.navigator?.locks) await navigator.locks.request(PENDING_SYNC_ALARM, schedule);
  else await schedule();
}

async function backlog(scope: string) {
  const [records, tombstones] = await Promise.all([
    workspaceRepository.list(scope),
    tombstoneRepository.list(scope.replace(/^workspaces/, STORAGE_KEYS.tombstones)),
  ]);
  return { records: records.filter((record) => ['pending', 'failed'].includes(record.sync.syncStatus)), deletes: tombstones.some((item) => !item.cloudDeletedAt) };
}

/** Local pending records are the durable queue; alarms survive a closed popup. */
export async function syncPendingWorkspaces() {
  const scope = await accountStorageKey(STORAGE_KEYS.workspaces);
  const pending = await backlog(scope);
  syncTrace('queue.snapshot', { scope, pending: pending.records.length, deleted: pending.deletes ? 1 : 0, source: 'src/lib/sync/pendingSync.ts:syncPendingWorkspaces' });
  if (!pending.records.length && !pending.deletes) return;
  try {
    if (pending.deletes) await syncEngine.syncAll(scope);
    else for (const record of pending.records) await syncEngine.syncWorkspace(record.content.id, scope);
  } finally {
    if (scope === await accountStorageKey(STORAGE_KEYS.workspaces)) {
      const remaining = await backlog(scope);
      if (remaining.records.length || remaining.deletes) await schedulePendingSync(5 * 60_000);
    }
  }
}
