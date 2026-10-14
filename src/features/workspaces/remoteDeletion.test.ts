import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ local: new Map<string, unknown>(), session: new Map<string, unknown>(), active: 'workspaces:["project","user-A"]',
  windows: [{ id: 1, tabs: [{ id: 10, active: true, url: 'chrome://newtab/', pinned: false }] }, { id: 2, tabs: [{ id: 20, active: true, url: 'https://unrelated.test', pinned: false }] }],
  badge: vi.fn(), title: vi.fn(), inject: vi.fn(), removeWindow: vi.fn(), removeTab: vi.fn(), permission: vi.fn() }));
vi.mock('wxt/browser', () => {
  const store = (map: Map<string, unknown>) => ({
    get: async (keys: string | string[] | null) => structuredClone(Object.fromEntries((keys === null ? [...map.keys()] : typeof keys === 'string' ? [keys] : keys).filter(k => map.has(k)).map(k => [k, map.get(k)]))),
    set: async (data: Record<string, unknown>) => { Object.entries(data).forEach(([key, value]) => map.set(key, structuredClone(value))); },
    remove: async (keys: string | string[]) => { (typeof keys === 'string' ? [keys] : keys).forEach(k => map.delete(k)); },
  });
  return { browser: { storage: { local: store(f.local), session: store(f.session) },
    windows: { getAll: async () => structuredClone(f.windows), get: async (id: number) => structuredClone(f.windows.find(w => w.id === id)), remove: f.removeWindow },
    tabs: { remove: f.removeTab }, action: { setBadgeText: f.badge, setTitle: f.title }, permissions: { contains: f.permission }, scripting: { executeScript: f.inject } } };
});
vi.mock('@/lib/storage/accountScope', () => ({ requireDataAccount: async (scope: string) => { if (scope !== f.active) throw new Error('account changed'); return { storageKey: scope }; }, withDataAccount: async (_account: unknown, task: () => Promise<unknown>) => task() }));
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { acknowledgeDeletion, captureDeletionWindow, deletionNoticeKey, notifyRemoteDeletion, readDeletionNotice, restoreDeletionNotices } from './remoteDeletion';
import { importNativeLibrary } from '@/lib/sync/nativeImport';
import { libraryStateKey } from '@/lib/companion/workspaces';
const scope = 'workspaces:["project","user-A"]', id = '11111111-1111-4111-8111-111111111111', stamp = '2026-10-14T00:00:00Z';
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); f.local.clear(); f.session.clear(); f.active = scope; f.windows[0]!.tabs[0]!.url = 'chrome://newtab/'; f.badge.mockResolvedValue(undefined); f.title.mockResolvedValue(undefined); f.permission.mockResolvedValue(false); });
afterEach(() => vi.useRealTimers());
describe('remote deletion affects only the bound window', () => {
  it('imports an explicit native deletion even when Chrome has unpublished edits, retaining a recoverable copy', async () => {
    const local = { content: { id, name: 'Unsent edits', tabs: [] }, sync: { syncStatus: 'pending' } };
    f.local.set(scope, { [id]: local }); f.local.set(libraryStateKey(scope), { revision: 1, pending: true });
    await bindingRepository.set(1, id, scope);
    const library = { generation: 2, revision: 1, digest: 'native', records: {}, deleted: [id], remote_deleted: { [id]: stamp }, delete_ack: [id], conflicts: {} };
    await importNativeLibrary(scope, async () => ({ status: 'read', generation: 2, chunks: 1, index: 0, part: Buffer.from(JSON.stringify(library)).toString('hex') }));
    expect(f.local.get(scope)).toEqual({}); expect(f.local.get(scope.replace(/^workspaces/, 'syncRecovery'))).toEqual({ [id]: [local] });
    expect(await readDeletionNotice(scope, 1)).not.toBeNull(); expect(await bindingRepository.get(1, scope)).toBeNull();
  });
  it('never treats a missing native list entry as deletion of a cached or offline-created workspace', async () => {
    f.local.set(scope, { [id]: { content: { id, name: 'Offline' }, sync: { syncStatus: 'pending' } } });
    const library = { generation: 0, revision: 0, digest: '', records: {}, deleted: [], remote_deleted: {}, delete_ack: [], conflicts: {} };
    await importNativeLibrary(scope, async () => ({ status: 'read', generation: 0, chunks: 1, index: 0, part: Buffer.from(JSON.stringify(library)).toString('hex') }));
    expect(f.local.get(scope)).toMatchObject({ [id]: { content: { name: 'Offline' } } });
    expect(f.local.get(scope.replace(/^workspaces/, 'deleteTombstones'))).toBeUndefined();
  });
  it('unbinds immediately, persists the notice and shows one icon fallback without touching tabs', async () => {
    await bindingRepository.set(1, id, scope); const before = structuredClone(f.windows);
    await notifyRemoteDeletion(scope, id, stamp); await Promise.resolve();
    expect(await bindingRepository.get(1, scope)).toBeNull(); expect(await bindingRepository.isSuppressed(1, scope)).toBe(true);
    expect(await readDeletionNotice(scope, 1)).toMatchObject({ workspaceId: id, deletedAt: stamp });
    expect(await readDeletionNotice(scope, 2)).toBeNull(); expect(f.windows).toEqual(before);
    expect(f.removeWindow).not.toHaveBeenCalled(); expect(f.removeTab).not.toHaveBeenCalled(); expect(f.inject).not.toHaveBeenCalled();
    expect(f.badge).toHaveBeenCalledWith({ tabId: 10, text: '!' });
    await notifyRemoteDeletion(scope, id, stamp); expect(f.badge).toHaveBeenCalledTimes(1);
    await expect(bindingRepository.set(1, id, scope)).rejects.toThrow('工作区已被删除');
    await vi.advanceTimersByTimeAsync(5_000); expect(f.badge).toHaveBeenLastCalledWith({ tabId: 10, text: '' });
  });
  it('keeps the notice across popup closes and Chrome restart; acknowledgement returns to suppressed/unbound', async () => {
    await bindingRepository.set(1, id, scope); await notifyRemoteDeletion(scope, id, stamp);
    const first = await readDeletionNotice(scope, 1); expect(await readDeletionNotice(scope, 1)).toEqual(first);
    f.session.clear(); await restoreDeletionNotices(scope); expect(await readDeletionNotice(scope, 1)).toEqual(first);
    await acknowledgeDeletion(scope, 1);
    expect(await readDeletionNotice(scope, 1)).toBeNull(); expect(f.local.get(deletionNoticeKey(scope))).toEqual({});
    expect(await bindingRepository.get(1, scope)).toBeNull(); expect(await bindingRepository.isSuppressed(1, scope)).toBe(true);
  });
  it('retains window edits for restart recognition and rejects a late acknowledgement after an account switch', async () => {
    await bindingRepository.set(1, id, scope); await notifyRemoteDeletion(scope, id, stamp);
    f.windows[0]!.tabs[0]!.url = 'https://edited.test'; await captureDeletionWindow(scope, 1);
    f.session.clear(); await restoreDeletionNotices(scope); expect((await readDeletionNotice(scope, 1))?.tabs[0]?.url).toBe('https://edited.test');
    f.active = 'workspaces:["project","user-B"]'; await expect(acknowledgeDeletion(scope, 1)).rejects.toThrow('account changed');
    expect(await readDeletionNotice(scope, 1)).not.toBeNull(); expect(await readDeletionNotice(f.active, 1)).toBeNull();
  });
  it('injects the weak hint only into a permitted affected tab, and never notifies unopened workspaces', async () => {
    f.windows[0]!.tabs[0]!.url = 'https://allowed.test'; f.permission.mockResolvedValue(true); f.inject.mockResolvedValue(undefined);
    await notifyRemoteDeletion(scope, id, stamp); expect(f.inject).not.toHaveBeenCalled();
    await bindingRepository.set(1, id, scope); await notifyRemoteDeletion(scope, id, stamp); await vi.advanceTimersByTimeAsync(0);
    expect(f.inject).toHaveBeenCalledOnce(); expect(f.inject.mock.calls[0]?.[0].target).toEqual({ tabId: 10 });
  });
});
