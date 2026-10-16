import { beforeEach, expect, it, vi } from 'vitest';
import type { NativeLibrary } from '../../../shared/workspaceSync';
import type { WorkspaceLocalRecord } from '@/types/workspace';

const fixture = vi.hoisted(() => ({ data: {} as Record<string, unknown>, library: {} as NativeLibrary, persist: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { storage: {
  local: { get: async () => structuredClone(fixture.data) },
  session: { get: async () => ({}) },
} } }));
vi.mock('@/lib/storage/accountScope', () => ({ requireDataAccount: async () => ({}), withDataAccount: async (_account: unknown, task: () => unknown) => task() }));
vi.mock('@/lib/companion/workspaces', () => ({ libraryStateKey: (scope: string) => `state:${scope}`, persistLibraryChange: fixture.persist }));
vi.mock('@/lib/storage/windowAssociationRepository', () => ({ windowAssociationRepository: { removeForWorkspaces: async () => {} } }));
vi.mock('@/features/workspaces/remoteDeletion', () => ({ notifyRemoteDeletion: vi.fn(), restoreDeletionNotices: async () => {} }));
vi.mock('../../../shared/workspaceSync', () => ({ readLibrary: async () => structuredClone(fixture.library) }));
import { importNativeLibrary } from './nativeImport';
import { configureDiagnostics, flushDiagnostics } from '../../../shared/syncDiagnostics';
import type { DiagnosticEvent } from '../../../shared/diagnostics';

const scope = 'workspaces:["https://fixture.supabase.test","user-A"]';
const recoveryKey = scope.replace('workspaces', 'syncRecovery');
const record: WorkspaceLocalRecord = {
  content: { id: 'one', name: 'A', status: 'active', tabs: [{ title: 'Tab', url: 'https://example.test', position: 0, pinned: false }], activeTabIndex: 0, createdAt: '2026-10-15', updatedAt: '2026-10-15' },
  sync: { syncStatus: 'synced', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: '2026-11-15', lastSyncError: null },
};
const reordered = (value: unknown): unknown => Array.isArray(value) ? value.map(reordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value;
const exchange = vi.fn();
beforeEach(() => {
  fixture.data = {};
  fixture.library = { revision: 1, generation: 1, digest: '', records: { one: record }, deleted: [], remote_deleted: {}, delete_ack: [], conflicts: {} };
  fixture.persist.mockReset().mockImplementation(async (_scope, changes) => { Object.assign(fixture.data, reordered(changes)); });
});
it('retains a failed import and records its safe reason while the next import can recover', async () => {
  const events: DiagnosticEvent[] = [];
  configureDiagnostics({ component: 'extension', sink: async event => { events.push(event); } });
  fixture.persist.mockRejectedValueOnce(new Error('invalid_workspace_chunk'));
  await expect(importNativeLibrary(scope, exchange)).rejects.toThrow('invalid_workspace_chunk');
  await importNativeLibrary(scope, exchange);
  await flushDiagnostics();
  expect(events.find(e => e.event === 'native.import.failed')?.errorCode).toBe('invalid_workspace_chunk');
  expect(events.some(e => e.event === 'native.import.done')).toBe(true);
});

it('does not echo unchanged native data back when Chrome reorders nested fields', async () => {
  fixture.data[scope] = reordered({ one: { ...record, accountStorageKey: scope } });
  await importNativeLibrary(scope, exchange);
  await importNativeLibrary(scope, exchange);
  expect(fixture.persist).not.toHaveBeenCalled();
});

it('converges after importing downloads and metadata-only conflict duplicates', async () => {
  const distinct = { ...record, content: { ...record.content, name: 'Unsent edit' } };
  fixture.library.conflicts.one = Array.from({ length: 147 }, (_, i) => ({ ...record, sync: { ...record.sync, lastSyncedAt: String(i) } }));
  fixture.data[recoveryKey] = reordered({ one: [...fixture.library.conflicts.one, distinct] });
  await importNativeLibrary(scope, exchange);
  await importNativeLibrary(scope, exchange);
  expect(fixture.persist).toHaveBeenCalledOnce();
  const versions = (fixture.data[recoveryKey] as Record<string, WorkspaceLocalRecord[]>).one!;
  expect(versions.map(item => item.content.name)).toEqual(['A', 'Unsent edit']);
});

it('keeps workspace, account, timestamp and tab-order differences across repeated imports and module restart', async () => {
  const secondTab = { ...record.content.tabs[0]!, url: 'https://second.test', position: 1 };
  const ordered = { ...record, content: { ...record.content, tabs: [...record.content.tabs, secondTab] } };
  const reversed = { ...ordered, content: { ...ordered.content, tabs: [...ordered.content.tabs].reverse() } };
  const dated = { ...record, content: { ...record.content, updatedAt: '2026-10-16' } };
  const otherWorkspace = { ...record, content: { ...record.content, id: 'two' } };
  const otherRecovery = recoveryKey.replace('user-A', 'user-B');
  fixture.data[otherRecovery] = { one: [dated] };
  fixture.library.conflicts = { one: [record, ordered, reversed, dated], two: [otherWorkspace] };
  await importNativeLibrary(scope, exchange);
  vi.resetModules();
  const restarted = (await import('./nativeImport')).importNativeLibrary;
  for (let i = 0; i < 20; i++) await restarted(scope, exchange);
  expect(fixture.persist).toHaveBeenCalledOnce();
  const recovery = fixture.data[recoveryKey] as Record<string, WorkspaceLocalRecord[]>;
  expect(recovery.one).toHaveLength(4);
  expect(recovery.two).toHaveLength(1);
  expect(fixture.data[otherRecovery]).toEqual({ one: [dated] });
});

it('preserves pending local edits while importing explicit remote deletion markers', async () => {
  fixture.data[scope] = { one: record };
  fixture.data[`state:${scope}`] = { pending: true };
  fixture.library.records.one = { ...record, content: { ...record.content, name: 'Remote' } };
  await importNativeLibrary(scope, exchange);
  expect(fixture.persist).not.toHaveBeenCalled();
  fixture.library.deleted = ['one']; fixture.library.remote_deleted.one = '2026-10-15';
  fixture.library.delete_ack = ['one'];
  await importNativeLibrary(scope, exchange);
  expect(fixture.data[scope]).toEqual({});
  expect(fixture.data[scope.replace('workspaces', 'deleteTombstones')]).toHaveProperty('one.cloudDeletedAt', '2026-10-15');
});
