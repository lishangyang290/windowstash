import { browser } from 'wxt/browser';
import { requireDataAccount, withDataAccount } from '@/lib/storage/accountScope';
import { libraryStateKey, persistLibraryChange } from '@/lib/companion/workspaces';
import { windowAssociationRepository } from '@/lib/storage/windowAssociationRepository';
import { notifyRemoteDeletion, restoreDeletionNotices } from '@/features/workspaces/remoteDeletion';
import type { DeleteTombstone, WorkspaceLocalRecord } from '@/types/workspace';
import { readLibrary, type LocalExchange } from '../../../shared/workspaceSync';
import { syncTrace } from '../../../shared/syncDiagnostics';
import { diagnosticErrorCode } from '../../../shared/diagnostics';
import type { TraceContext } from '../../../shared/diagnostics';

// Chrome storage and Rust serialize object fields in different orders.
const serialized = (value: unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

let imports = Promise.resolve();
export function importNativeLibrary(scope: string, exchange: LocalExchange, diagnostic?: TraceContext): Promise<void> {
  const started = performance.now();
  const trace = syncTrace('native.import.start', { scope, trace: diagnostic });
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
      for (const [id, versions] of Object.entries(recovery)) {
        recovery[id] = [...new Map(versions.map(record => [serialized(record.content), record])).values()];
      }
      for (const [id, versions] of Object.entries(library.conflicts)) {
        const copies = recovery[id] ??= [];
        const known = new Set(copies.map(copy => serialized(copy.content)));
        for (const version of versions) {
          const key = serialized(version.content);
          if (!known.has(key)) { copies.push(version); known.add(key); }
        }
      }
      for (const id of library.deleted) {
        const previous = records[id];
        if (library.remote_deleted[id] && previous && previous.sync.syncStatus !== 'synced') {
          const versions = recovery[id] ??= [];
          if (!versions.some(record => serialized(record.content) === serialized(previous.content))) versions.push(previous);
        }
        if (library.remote_deleted[id] && !tombstones[id] && boundIds.has(id)) await notifyRemoteDeletion(scope, id, library.remote_deleted[id]);
        tombstones[id] ??= { workspaceId: id, workspaceName: records[id]?.content.name ?? '', deletedAt: library.remote_deleted[id] ?? new Date().toISOString(), accountStorageKey: tombstoneKey };
        if (library.delete_ack.includes(id)) tombstones[id].cloudDeletedAt ??= library.remote_deleted[id] ?? new Date().toISOString();
        delete next[id];
      }
      if (serialized(next) !== serialized(records) || serialized(tombstones) !== serialized(local[tombstoneKey] ?? {}) || serialized(recovery) !== serialized(local[recoveryKey] ?? {})) {
        await persistLibraryChange(scope, { [scope]: next, [tombstoneKey]: tombstones, [recoveryKey]: recovery });
      }
    });
    await withDataAccount(account, () => restoreDeletionNotices(scope));
    syncTrace('native.import.done', { trace, scope, generation: library.generation, elapsedMs: performance.now() - started });
  });
  imports = task.catch(error => { syncTrace('native.import.failed', { trace, scope, errorCode: diagnosticErrorCode(error), elapsedMs: performance.now() - started }); }); return task;
}
