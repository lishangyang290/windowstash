import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ local: new Map<string, unknown>(), session: new Map<string, unknown>(), getWindow: vi.fn(), sendMessage: vi.fn(async () => undefined) }));
function storage(values: Map<string, unknown>) { return {
  get: async (keys: string | string[] | null) => Object.fromEntries((keys === null ? [...values.keys()] : Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(values.get(key))])),
  set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value)); },
  remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
}; }
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: storage(state.local), session: storage(state.session) },
  windows: { get: state.getWindow, getAll: async () => [], remove: vi.fn() },
  runtime: { sendMessage: state.sendMessage, getURL: (path: string) => `chrome-extension://fixture${path}` },
} }));
vi.mock('@/lib/sync/syncEngine', () => ({ syncEngine: { syncAll: async () => {} } }));
import { accountOwner, hideDataAccount, initializeDataAccount, legacyDataSummary, selectDataAccount } from '@/lib/storage/accountScope';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { openWorkspaceTab, reopenSavedTab, focusWindowTab, saveCurrentWindow, updateWorkspace, deleteWorkspace, resolveWorkspaceStateForWindow } from '../workspaceService';
afterEach(() => vi.unstubAllGlobals());
const project = 'https://fixture.supabase.test';
const tokenKey = 'windowstash-auth:sb-fixture-auth-token';
const input = { windowId: 1, name: 'A window', status: 'active' as const, closeAfterSave: false };
const tabs = [{ id: 1, index: 0, url: 'https://example.test', title: 'Page', pinned: false, active: true }];
async function login(user: string) {
  state.local.set('supabaseConfig', { url: project, publishableKey: 'fixture' });
  state.local.set(tokenKey, JSON.stringify({ user: { id: user } }));
  await selectDataAccount(project, user);
}
async function logout() { await hideDataAccount(); state.local.delete(tokenKey); }
beforeEach(() => {
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', { locks: { request: (name: string, task: () => Promise<unknown>) => {
    const next = (queues.get(name) ?? Promise.resolve()).then(task, task);
    queues.set(name, next.catch(() => {})); return next;
  } } });
  state.local.clear(); state.session.clear(); vi.clearAllMocks(); state.getWindow.mockResolvedValue({ id: 1, tabs }); });
it('requires both configured project and account before saving, then saves an explicitly owned workspace', async () => {
  await expect(saveCurrentWindow(input)).rejects.toThrow('请先登录');
  state.local.set('supabaseConfig', { url: project, publishableKey: 'fixture' });
  await expect(saveCurrentWindow(input)).rejects.toThrow('请先登录');
  expect(state.getWindow).not.toHaveBeenCalled();
  await login('A'); const saved = await saveCurrentWindow(input);
  expect((await workspaceRepository.get(saved.id))?.accountStorageKey).toBe(`workspaces:${accountOwner(project, 'A')}`);
  expect(state.local.has('workspaces')).toBe(false);
  expect(state.local.has('workspaces:signed-out')).toBe(false);
});
it('blocks save/update/delete after logout and restores original workspace and window binding after relogin', async () => {
  await login('A'); const saved = await saveCurrentWindow(input); const before = structuredClone(state.local);
  await logout();
  await expect(saveCurrentWindow(input)).rejects.toThrow('请先登录');
  await expect(updateWorkspace(saved.id, { name: 'anonymous edit' })).rejects.toThrow('请先登录');
  await expect(deleteWorkspace(saved.id)).rejects.toThrow('请先登录');
  await expect(openWorkspaceTab(tabs[0]!.url)).rejects.toThrow('请先登录');
  await expect(focusWindowTab(1, 1)).rejects.toThrow('请先登录');
  await expect(reopenSavedTab(1, { ...tabs[0]!, position: 0 })).rejects.toThrow('请先登录');
  expect(await workspaceRepository.list()).toEqual([]); expect(await bindingRepository.get(1)).toBeNull();
  expect(state.local.get(`workspaces:${accountOwner(project, 'A')}`)).toEqual(before.get(`workspaces:${accountOwner(project, 'A')}`));
  await login('A'); expect(await bindingRepository.get(1)).toBe(saved.id);
  expect((await resolveWorkspaceStateForWindow(1, tabs)).workspaceId).toBe(saved.id);
});
it('isolates A → logout → B without losing A data or claiming A window bindings', async () => {
  await login('A'); const saved = await saveCurrentWindow(input); await logout(); await login('B');
  expect(await workspaceRepository.list()).toEqual([]); expect(await bindingRepository.get(1)).toBeNull();
  await expect(updateWorkspace(saved.id, { name: 'B edit' })).rejects.toThrow('不存在');
  await login('A'); expect((await workspaceRepository.get(saved.id))?.content.name).toBe(input.name);
  expect(await bindingRepository.get(1)).toBe(saved.id);
});
it.each(['logout', 'B', 'A again'])('rejects pending save when identity changes: %s', async (next) => {
  await login('A');
  let resolve!: (window: { id: number; tabs: typeof tabs }) => void;
  state.getWindow.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const pending = saveCurrentWindow(input); const rejected = expect(pending).rejects.toThrow(next === 'logout' ? '请先登录' : '账号已变化');
  await vi.waitFor(() => expect(resolve).toBeDefined());
  await logout(); if (next !== 'logout') await login(next === 'B' ? 'B' : 'A');
  resolve({ id: 1, tabs }); await rejected;
  expect([...state.local.keys()].filter((key) => key.startsWith('workspaces'))).toEqual([]);
  expect(state.session.size).toBe(0); expect(state.sendMessage).not.toHaveBeenCalled();
});
it('refuses writes while login identity has changed but account selection has not completed', async () => {
  await login('A'); state.local.set(tokenKey, JSON.stringify({ user: { id: 'B' } }));
  await expect(saveCurrentWindow(input)).rejects.toThrow('请先登录');
  expect(state.getWindow).not.toHaveBeenCalled();
});
it('never reactivates stale session during logout and preserves orphan data for explicit recovery only', async () => {
  await login('A'); const saved = await saveCurrentWindow(input); await hideDataAccount();
  await initializeDataAccount(project, 'A');
  await expect(saveCurrentWindow(input)).rejects.toThrow('请先登录');
  const orphan = { content: { ...saved, id: 'orphan', name: 'unowned' }, sync: (await workspaceRepository.get(saved.id, `workspaces:${accountOwner(project, 'A')}`))!.sync };
  state.local.set('workspaces:signed-out', { orphan });
  await login('B'); expect(await workspaceRepository.get('orphan')).toBeNull();
  expect(await legacyDataSummary()).toEqual({ workspaces: 1, tombstones: 0 });
  await selectDataAccount(project, 'B', true);
  expect((await workspaceRepository.get('orphan'))?.content.name).toBe('unowned');
  expect(state.local.get('workspaces:signed-out')).toEqual({ orphan });
  await login('A'); expect(await workspaceRepository.get('orphan')).toBeNull();
  expect((await workspaceRepository.get(saved.id))?.content.name).toBe(input.name);
});

it.each(['A', 'B'])('rejects an unfinished update after logout and login as %s', async (user) => {
  await login('A'); const saved = await saveCurrentWindow(input);
  const record = await workspaceRepository.get(saved.id);
  let finish!: (value: typeof record) => void;
  const get = vi.spyOn(workspaceRepository, 'get').mockImplementationOnce(() => new Promise((done) => { finish = done; }));
  const pending = updateWorkspace(saved.id, { name: 'late update' });
  const rejected = expect(pending).rejects.toThrow('账号已变化');
  await vi.waitFor(() => expect(finish).toBeDefined());
  await logout(); await login(user); finish(record); await rejected; get.mockRestore();
  await login('A'); expect((await workspaceRepository.get(saved.id))?.content.name).toBe(input.name);
});

it('rejects a stale A popup after B logs in, even if both accounts use the same workspace id', async () => {
  await login('A'); const a = await saveCurrentWindow(input);
  const keyA = `workspaces:${accountOwner(project, 'A')}`;
  await logout(); await login('B');
  await workspaceRepository.saveContent({ ...a, name: 'B window' });
  await expect(saveCurrentWindow({ ...input, accountStorageKey: keyA })).rejects.toThrow('账号已变化');
  await expect(updateWorkspace(a.id, { name: 'stale A edit' }, keyA)).rejects.toThrow('账号已变化');
  expect((await workspaceRepository.get(a.id))?.content.name).toBe('B window');
});

it('serializes an already committing A save with logout and B selection without writing to B or orphan storage', async () => {
  await login('A');
  const original = workspaceRepository.saveContent.bind(workspaceRepository);
  let release!: () => void;
  const write = vi.spyOn(workspaceRepository, 'saveContent').mockImplementationOnce(async (...args) => {
    await new Promise<void>((done) => { release = done; }); return original(...args);
  });
  const pending = saveCurrentWindow(input);
  await vi.waitFor(() => expect(release).toBeDefined());
  const signedOut = hideDataAccount(); const switched = login('B');
  release(); const saved = await pending; await signedOut; await switched; write.mockRestore();
  expect(await workspaceRepository.list()).toEqual([]);
  expect(state.local.has('workspaces:signed-out')).toBe(false);
  await login('A'); expect((await workspaceRepository.get(saved.id))?.content.name).toBe(input.name);
});
