import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudWorkspaceRow, WorkspaceContent } from '@/types/workspace';
const state = vi.hoisted(() => ({ local: new Map<string, unknown>(), session: new Map<string, unknown>(), remote: { isAuthenticated: vi.fn(), get: vi.fn(), list: vi.fn(), upsert: vi.fn(), remove: vi.fn() } }));
function storage(values: Map<string, unknown>) { return {
  get: async (keys: string | string[] | null) => Object.fromEntries((keys === null ? [...values.keys()] : Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(values.get(key))])),
  set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value)); },
  remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
}; }
vi.mock('wxt/browser', () => ({ browser: { storage: { local: storage(state.local), session: storage(state.session) }, windows: { getAll: async () => [] } } }));
vi.mock('@/lib/supabase/workspaceRemoteRepository', () => ({ workspaceRemoteRepository: state.remote }));
import { accountOwner, accountStorageKey, selectDataAccount, hideDataAccount, initializeDataAccount, legacyDataSummary } from '@/lib/storage/accountScope';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { tombstoneRepository } from '@/lib/storage/tombstoneRepository';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { lazyRestoreRepository } from '@/lib/storage/lazyRestoreRepository';
import { windowAssociationRepository } from '@/lib/storage/windowAssociationRepository';
import { syncEngine } from './syncEngine';
const project = 'https://project1.supabase.co';
const content: WorkspaceContent = { id: 'same-id', name: 'A offline', tabs: [], status: 'active', activeTabIndex: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
async function login(url: string, userId: string) {
  state.local.set('supabaseConfig', { url, publishableKey: 'fixture' });
  state.local.set(`windowstash-auth:sb-${new URL(url).hostname.split('.')[0]}-auth-token`, JSON.stringify({ user: { id: userId } }));
  await selectDataAccount(url, userId);
}
async function seed(name = content.name) {
  await workspaceRepository.saveContent({ ...content, name });
  await tombstoneRepository.add({ workspaceId: 'deleted-A', workspaceName: `${name} deleted`, deletedAt: '2026-01-01' });
  await syncLogRepository.add({ workspaceId: content.id, workspaceName: name, action: 'local-save', result: 'success', message: 'offline' });
  await bindingRepository.set(11, content.id);
  await lazyRestoreRepository.put({ id: 'lazy-A', workspaceId: content.id, originalUrl: 'https://a.example', title: name, favIconUrl: '', position: 0, pinned: false, createdAt: '2026-01-01' });
  await windowAssociationRepository.upsert(content.id, { tabs: [], activeTabIndex: 0 });
}
beforeEach(() => {
  state.local.clear(); state.session.clear(); vi.clearAllMocks();
  state.remote.isAuthenticated.mockResolvedValue(true);
  state.remote.get.mockResolvedValue(null); state.remote.list.mockResolvedValue([]);
});
describe('local-first account/project round trips', () => {
  it('keeps concurrent deletion markers and other workspace saves', async () => {
    await login(project, 'A');
    await Promise.all(['one', 'two'].map((workspaceId) => tombstoneRepository.add({ workspaceId, workspaceName: workspaceId, deletedAt: '2026-01-01' })));
    expect((await tombstoneRepository.list()).map((item) => item.workspaceId).sort()).toEqual(['one', 'two']);
    await Promise.all(['one', 'two'].map((id) => workspaceRepository.saveContent({ ...content, id: `saved-${id}` })));
    expect(await workspaceRepository.list()).toHaveLength(2);
  });
  it('retains deletion evidence after cloud success and rejects a stale cloud download', async () => {
    await login(project, 'A');
    const key = await accountStorageKey('workspaces');
    await tombstoneRepository.add({ workspaceId: content.id, workspaceName: content.name, deletedAt: '2026-01-01' });
    state.remote.remove.mockResolvedValue(undefined);
    state.remote.list.mockResolvedValue([{ id: content.id, user_id: 'A', name: content.name, tabs: [], status: 'active', active_tab_index: 0, content_hash: 'old', created_at: content.createdAt, updated_at: content.updatedAt, accountStorageKey: key }]);
    await syncEngine.syncAll();
    expect(await workspaceRepository.get(content.id)).toBeNull();
    expect(await tombstoneRepository.has(content.id)).toBe(true);
    expect((await tombstoneRepository.list())[0]?.cloudDeletedAt).toBeTruthy();
    await workspaceRepository.put({ accountStorageKey: key, content, sync: { syncStatus: 'synced', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: '2027-01-01', lastSyncError: null } });
    expect(await workspaceRepository.get(content.id)).toBeNull();
    await expect(workspaceRepository.saveContent(content)).rejects.toThrow('工作区已删除');
    await syncEngine.syncAll();
    expect(state.remote.remove).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight upload before deleting remotely and never restores it locally', async () => {
    await login(project, 'A');
    await workspaceRepository.saveContent(content);
    const key = await accountStorageKey('workspaces');
    let finish!: (row: CloudWorkspaceRow) => void;
    state.remote.upsert.mockImplementationOnce(() => new Promise<CloudWorkspaceRow>((resolve) => { finish = resolve; }));
    const upload = syncEngine.syncWorkspace(content.id);
    await vi.waitFor(() => expect(state.remote.upsert).toHaveBeenCalledOnce());
    await tombstoneRepository.add({ workspaceId: content.id, workspaceName: content.name, deletedAt: '2026-01-01' });
    await workspaceRepository.remove(content.id);
    const deletion = syncEngine.syncAll();
    await Promise.resolve();
    expect(state.remote.remove).not.toHaveBeenCalled();
    finish({ id: content.id, user_id: 'A', name: content.name, tabs: [], status: 'active', active_tab_index: 0, content_hash: 'old', created_at: content.createdAt, updated_at: content.updatedAt, accountStorageKey: key });
    await Promise.all([upload, deletion]);
    expect(state.remote.remove).toHaveBeenCalledOnce();
    expect(await workspaceRepository.get(content.id)).toBeNull();
    expect(await tombstoneRepository.has(content.id)).toBe(true);
  });
  it.each([[project, 'B'], ['https://project2.supabase.co', 'A']])('keeps offline data and all ancillary stores isolated through A → %s/%s → A', async (url, user) => {
    await login(project, 'A'); await seed();
    const keyA = await accountStorageKey('workspaces');
    await login(url, user);
    expect(await workspaceRepository.list()).toEqual([]);
    expect(await tombstoneRepository.list()).toEqual([]);
    expect(await syncLogRepository.list()).toEqual([]);
    expect(await lazyRestoreRepository.list()).toEqual([]);
    expect(await windowAssociationRepository.list()).toEqual([]);
    expect(await bindingRepository.get(11)).toBeNull();
    await workspaceRepository.saveContent({ ...content, name: 'B offline' });
    await login(project, 'A');
    expect((await workspaceRepository.get(content.id))?.content.name).toBe('A offline');
    expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
    expect(await tombstoneRepository.has('deleted-A')).toBe(true);
    expect(await syncLogRepository.list()).toHaveLength(1);
    expect(await lazyRestoreRepository.list()).toHaveLength(1);
    expect(await windowAssociationRepository.list()).toHaveLength(1);
    expect(await bindingRepository.get(11)).toBe(content.id);
    expect(state.local.has(keyA)).toBe(true);
    await login(url, user);
    expect((await workspaceRepository.get(content.id))?.content.name).toBe('B offline');
  });
  it('hides signed-out data immediately without deleting pending workspaces', async () => {
    await login(project, 'A'); await seed(); await hideDataAccount();
    expect(await workspaceRepository.list()).toEqual([]);
    expect(await tombstoneRepository.list()).toEqual([]);
    await login(project, 'A');
    expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
  });
  it('writes an in-flight A upload and its log back to A while B has the same workspace ID', async () => {
    await login(project, 'A'); await workspaceRepository.saveContent(content);
    let finish!: (row: CloudWorkspaceRow) => void;
    state.remote.upsert.mockImplementation(() => new Promise<CloudWorkspaceRow>((resolve) => { finish = resolve; }));
    const task = syncEngine.syncWorkspace(content.id);
    await vi.waitFor(() => expect(state.remote.upsert).toHaveBeenCalledOnce());
    const keyA = `workspaces:${accountOwner(project, 'A')}`;
    expect(state.remote.upsert).toHaveBeenCalledWith(content, expect.any(String), keyA);
    await login(project, 'B'); await workspaceRepository.saveContent({ ...content, name: 'B offline' });
    finish({ id: content.id, user_id: 'A', name: content.name, tabs: [], status: 'active', active_tab_index: 0, content_hash: 'hash', created_at: content.createdAt, updated_at: content.updatedAt, accountStorageKey: keyA });
    await task;
    expect((await workspaceRepository.get(content.id))?.content.name).toBe('B offline');
    expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
    expect(await syncLogRepository.list()).toEqual([]);
    await login(project, 'A');
    expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('synced');
    expect(await syncLogRepository.list()).toHaveLength(1);
  });
  it('keeps failed deletes and logs in their original scope after a switch', async () => {
    await login(project, 'A');
    await tombstoneRepository.add({ workspaceId: 'deleted-A', workspaceName: 'A', deletedAt: '2026-01-01' });
    state.remote.remove.mockImplementation(async () => { await login(project, 'B'); throw new Error('account changed'); });
    await syncEngine.syncAll();
    expect(await tombstoneRepository.list()).toEqual([]);
    expect(await syncLogRepository.list()).toEqual([]);
    await login(project, 'A');
    expect(await tombstoneRepository.has('deleted-A')).toBe(true);
    expect((await syncLogRepository.list())[0]?.result).toBe('failed');
  });
  it('preserves newer A offline edits when an older A upload finishes after switching to B', async () => {
    await login(project, 'A'); await workspaceRepository.saveContent(content);
    const keyA = await accountStorageKey('workspaces');
    let finish!: (row: CloudWorkspaceRow) => void;
    state.remote.upsert.mockImplementation(() => new Promise<CloudWorkspaceRow>((resolve) => { finish = resolve; }));
    const task = syncEngine.syncWorkspace(content.id);
    await vi.waitFor(() => expect(state.remote.upsert).toHaveBeenCalledOnce());
    await workspaceRepository.saveContent({ ...content, name: 'A newer unsynced edit' });
    await login(project, 'B');
    finish({ id: content.id, user_id: 'A', name: content.name, tabs: [], status: 'active', active_tab_index: 0, content_hash: 'hash', created_at: content.createdAt, updated_at: content.updatedAt, accountStorageKey: keyA });
    await task;
    expect(await workspaceRepository.list()).toEqual([]);
    await login(project, 'A');
    expect((await workspaceRepository.get(content.id))?.content.name).toBe('A newer unsynced edit');
    expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
  });

});

it('runs the complete A1 → A2 → B1 → A1 flow for every local-first store and survives reloading modules', async () => {
  const accounts = [[project, 'user-1'], [project, 'user-2'], ['https://project2.supabase.co', 'user-1']] as const;
  const snapshot = async () => ({ workspaces: await workspaceRepository.list(), deletes: await tombstoneRepository.list(), logs: await syncLogRepository.list(), lazy: await lazyRestoreRepository.list(), associations: await windowAssociationRepository.list(), binding: await bindingRepository.get(11) });
  const saved = [];
  for (const [index, [url, user]] of accounts.entries()) {
    await login(url, user);
    expect((await snapshot()).workspaces).toEqual([]);
    await seed(['A1', 'A2', 'B1'][index]);
    saved.push(await snapshot());
  }
  await login(...accounts[0]); expect(await snapshot()).toEqual(saved[0]);
  vi.resetModules();
  const reloaded = await import('@/lib/storage/workspaceRepository');
  expect((await reloaded.workspaceRepository.get(content.id))?.content.name).toBe('A1');
  expect((await reloaded.workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
  for (const [index, [url, user]] of accounts.entries()) {
    await login(url, user); expect(await snapshot()).toEqual(saved[index]);
  }
});
it('automatically restores known legacy owner data and metadata without deleting the original backup', async () => {
  await seed();
  state.local.set('supabaseConfig', { url: project, publishableKey: 'fixture' });
  state.local.set('windowstash-auth:sb-project1-auth-token', JSON.stringify({ user: { id: 'A' } }));
  await initializeDataAccount(project, 'A');
  expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
  expect(await tombstoneRepository.has('deleted-A')).toBe(true);
  expect(await bindingRepository.get(11)).toBe(content.id);
  expect(await lazyRestoreRepository.list()).toHaveLength(1);
  expect(await windowAssociationRepository.list()).toHaveLength(1);
  expect(await syncLogRepository.list()).toHaveLength(1);
  expect(state.local.has('workspaces')).toBe(true);
  await login(project, 'B'); expect(await workspaceRepository.list()).toEqual([]);
  await login(project, 'A'); expect((await workspaceRepository.get(content.id))?.content.name).toBe(content.name);
});
it('reports unowned old data, requires explicit recovery, and keeps newer records on ID collisions', async () => {
  await seed();
  await workspaceRepository.saveContent({ ...content, id: 'legacy-only', name: 'old pending data' });
  await login(project, 'A');
  await workspaceRepository.saveContent({ ...content, name: 'newer A1 edit' });
  expect(await legacyDataSummary()).toEqual({ workspaces: 2, tombstones: 1 });
  await login(project, 'B');
  expect(await workspaceRepository.list()).toEqual([]);
  await login(project, 'A');
  await selectDataAccount(project, 'A', true);
  expect((await workspaceRepository.get(content.id))?.content.name).toBe('newer A1 edit');
  expect((await workspaceRepository.get('legacy-only'))?.sync.syncStatus).toBe('pending');
  expect(await tombstoneRepository.has('deleted-A')).toBe(true);
  expect(await legacyDataSummary()).toEqual({ workspaces: 0, tombstones: 0 });
  expect((state.local.get('workspaces') as Record<string, unknown>)[content.id]).toBeTruthy();
  await login(project, 'B'); await selectDataAccount(project, 'B', true);
  expect(await workspaceRepository.list()).toEqual([]);
  await login(project, 'A'); expect(await workspaceRepository.list()).toHaveLength(2);
});

it('cleans failed lazy restores in their original account while another account uses the same id', async () => {
  await login(project, 'A'); await seed('A');
  const key = await accountStorageKey('lazyRestoreEntries');
  await login(project, 'B'); await seed('B');
  await lazyRestoreRepository.remove('lazy-A', key);
  expect((await lazyRestoreRepository.get('lazy-A'))?.title).toBe('B');
  await login(project, 'A');
  expect(await lazyRestoreRepository.get('lazy-A')).toBeNull();
  await lazyRestoreRepository.put({ id: 'lazy-A', workspaceId: content.id, originalUrl: 'https://a.example', title: 'A', favIconUrl: '', position: 0, pinned: false, createdAt: '2026-01-01' });
  await login(project, 'B');
  await lazyRestoreRepository.removeMany(['lazy-A'], key);
  expect((await lazyRestoreRepository.get('lazy-A'))?.title).toBe('B');
  await login(project, 'A');
  expect(await lazyRestoreRepository.get('lazy-A')).toBeNull();
});
