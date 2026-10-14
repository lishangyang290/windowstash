import { browser } from 'wxt/browser';
import { requireDataAccount, withDataAccount } from '@/lib/storage/accountScope';
import { libraryStateKey, persistLibraryChange } from '@/lib/companion/workspaces';
import { windowAssociationRepository } from '@/lib/storage/windowAssociationRepository';
import { notifyRemoteDeletion, restoreDeletionNotices } from '@/features/workspaces/remoteDeletion';
import type { DeleteTombstone, WorkspaceLocalRecord } from '@/types/workspace';
import { readLibrary, type LocalExchange } from '../../../shared/workspaceSync';

let imports = Promise.resolve();
export function importNativeLibrary(scope: string, exchange: LocalExchange): Promise<void> {
  const task = imports.then(async () => {
    const library = await readLibrary(exchange), account = await requireDataAccount(scope);
    await withDataAccount(account, async () => {
      const tombstoneKey = scope.replace(/^workspaces/, 'deleteTombstones'), stateKey = libraryStateKey(scope);
      const recoveryKey = scope.replace(/^workspaces/, 'syncRecovery');
      const local = await browser.storage.local.get([scope, tombstoneKey, stateKey, recoveryKey]);
      const pending = (local[stateKey] as { pending?: boolean } | undefined)?.pending;
      const records = local[scope] as Record<string, WorkspaceLocalRecord> ?? {};
      const tombstones = structuredClone(local[tombstoneKey] as Record<string, DeleteTombstone> ?? {});
      const bindings = await browser.storage.session.get(null);
      const boundIds = new Set(Object.entries(bindings).filter(([key]) => key.startsWith('windowBinding:') && key.endsWith(scope.slice('workspaces'.length))).map(([, value]) => value));
      await windowAssociationRepository.removeForWorkspaces(new Set(library.deleted), scope);
      // Never infer deletion from missing records. Only explicit native markers remove cached IDs.
      const next = pending ? { ...records } : { ...records, ...Object.fromEntries(Object.entries(library.records).map(([id, record]) => [id, { ...record, accountStorageKey: scope }])) };
      const recovery = structuredClone(local[recoveryKey] as Record<string, WorkspaceLocalRecord[]> ?? {});
      for (const [id, versions] of Object.entries(library.conflicts)) {
        const copies = recovery[id] ??= [];
        for (const version of versions) if (!copies.some(copy => JSON.stringify(copy.content) === JSON.stringify(version.content))) copies.push(version);
      }
      for (const id of library.deleted) {
        const previous = records[id];
        if (library.remote_deleted[id] && previous && previous.sync.syncStatus !== 'synced') {
          const versions = recovery[id] ??= [];
          if (!versions.some(record => JSON.stringify(record.content) === JSON.stringify(previous.content))) versions.push(previous);
        }
        if (library.remote_deleted[id] && !tombstones[id] && boundIds.has(id)) await notifyRemoteDeletion(scope, id, library.remote_deleted[id]);
        tombstones[id] ??= { workspaceId: id, workspaceName: records[id]?.content.name ?? '', deletedAt: library.remote_deleted[id] ?? new Date().toISOString(), accountStorageKey: tombstoneKey };
        if (library.delete_ack.includes(id)) tombstones[id].cloudDeletedAt ??= library.remote_deleted[id] ?? new Date().toISOString();
        delete next[id];
      }
      if (JSON.stringify(next) !== JSON.stringify(records) || JSON.stringify(tombstones) !== JSON.stringify(local[tombstoneKey] ?? {}) || JSON.stringify(recovery) !== JSON.stringify(local[recoveryKey] ?? {})) {
        await persistLibraryChange(scope, { [scope]: next, [tombstoneKey]: tombstones, [recoveryKey]: recovery });
      }
    });
    await withDataAccount(account, () => restoreDeletionNotices(scope));
  });
  imports = task.catch(() => undefined); return task;
}
