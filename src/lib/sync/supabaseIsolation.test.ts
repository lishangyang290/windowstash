import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identities, ownerOf, SupabaseMemory } from '../../../tests/support/supabaseMemory';
import type { Session } from '@supabase/supabase-js';
const state = vi.hoisted(() => ({ local: new Map<string, unknown>(), session: new Map<string, unknown>(), config: null as { url: string; publishableKey: string } | null, auth: null as Session | null }));
function storage(values: Map<string, unknown>) { return {
  get: async (keys: string | string[] | null) => Object.fromEntries((keys === null ? [...values.keys()] : Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(values.get(key))])),
  set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value)); },
  remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
}; }
vi.mock('wxt/browser', () => ({ browser: { storage: { local: storage(state.local), session: storage(state.session) }, windows: { getAll: async () => [] } } }));
vi.mock('@/lib/supabase/client', () => ({ getSupabaseConfig: async () => state.config, getSupabaseClient: async () => ({ auth: { getSession: async () => ({ data: { session: state.auth }, error: null }) } }), friendlySupabaseError: (error: unknown) => error }));
import { selectDataAccount } from '@/lib/storage/accountScope';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { tombstoneRepository } from '@/lib/storage/tombstoneRepository';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import { workspaceRemoteRepository } from '@/lib/supabase/workspaceRemoteRepository';
import { syncEngine } from './syncEngine';
const content = { id: 'shared-id', name: '', status: 'active' as const, tabs: [], activeTabIndex: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
let server: SupabaseMemory;
async function login(index: number) {
  const identity = identities[index]!;
  state.config = { url: identity.url, publishableKey: 'mock-publishable-key' };
  state.auth = { access_token: identity.token, user: { id: identity.userId } } as Session;
  state.local.set('supabaseConfig', state.config);
  state.local.set(`windowstash-auth:sb-${new URL(identity.url).hostname.split('.')[0]}-auth-token`, JSON.stringify(state.auth));
  await selectDataAccount(identity.url, identity.userId);
  return `workspaces:${ownerOf(identity.url, identity.userId)}`;
}
beforeEach(() => {
  state.local.clear(); state.session.clear(); state.config = null; state.auth = null;
  server = new SupabaseMemory(); vi.stubGlobal('fetch', server.fetch);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('real sync engine and real Supabase SDK against simulated projects/users', () => {
  it('restores every offline queue through A1 → A2 → B1 → A1 and syncs only its owner', async () => {
    vi.useFakeTimers();
    for (const [index, name] of ['A1', 'A2', 'B1'].entries()) {
      await login(index);
      expect(await workspaceRepository.list()).toEqual([]);
      expect(await tombstoneRepository.list()).toEqual([]);
      await workspaceRepository.saveContent({ ...content, name });
      await tombstoneRepository.add({ workspaceId: 'deleted-id', workspaceName: `${name} deleted`, deletedAt: '2026-01-01' });
      server.offline = true;
      const offlineTask = syncEngine.syncAll();
      await vi.runAllTimersAsync();
      await offlineTask;
      expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('failed');
      expect(await tombstoneRepository.has('deleted-id')).toBe(true);
    }
    vi.useRealTimers();
    await login(0);
    expect((await workspaceRepository.get(content.id))?.content.name).toBe('A1');
    expect(await tombstoneRepository.has('deleted-id')).toBe(true);
    server.offline = false; server.requests.length = 0;
    await syncEngine.syncAll();
    expect(server.requests.every((request) => request.owner === ownerOf(identities[0].url, identities[0].userId))).toBe(true);
    expect(server.account(identities[0].url, identities[0].userId).get(content.id)?.name).toBe('A1');
    expect(await tombstoneRepository.has('deleted-id')).toBe(true);
    expect((await tombstoneRepository.list()).find((item) => item.workspaceId === 'deleted-id')?.cloudDeletedAt).toBeTruthy();
    for (const [index, name] of [[1, 'A2'], [2, 'B1']] as const) {
      await login(index);
      expect((await workspaceRepository.get(content.id))?.content.name).toBe(name);
      expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('failed');
      expect(await tombstoneRepository.has('deleted-id')).toBe(true);
      expect(server.account(identities[index].url, identities[index].userId).size).toBe(0);
    }
  });
  it('rejects queued A1 uploads/deletes under both A2 and B1 before issuing a request', async () => {
    const key = await login(0);
    await workspaceRepository.saveContent({ ...content, name: 'A1' });
    await tombstoneRepository.add({ workspaceId: 'deleted-id', workspaceName: 'A1 deleted', deletedAt: '2026-01-01' });
    const original = (await workspaceRepository.get(content.id))!;
    for (const index of [1, 2]) {
      await login(index);
      await workspaceRepository.saveContent({ ...content, name: 'other account, same ID' });
      server.requests.length = 0;
      await syncEngine.syncAll(key);
      await expect(workspaceRemoteRepository.remove('deleted-id', key.replace(/^workspaces/, 'deleteTombstones'))).rejects.toThrow('其他账号');
      expect(server.requests).toEqual([]);
      expect(await syncLogRepository.list()).toEqual([]);
    }
    await login(0);
    expect((await workspaceRepository.get(content.id))?.content).toEqual(original.content);
  });
  it('routes a delayed A1 upload completion to A1 after switching to B1', async () => {
    await login(0); await workspaceRepository.saveContent({ ...content, name: 'A1' });
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    server.beforeRequest = (request) => request.method === 'POST' ? gate : undefined;
    const task = syncEngine.syncWorkspace(content.id);
    await vi.waitFor(() => expect(server.requests.some((request) => request.method === 'POST')).toBe(true));
    await login(2); await workspaceRepository.saveContent({ ...content, name: 'B1' });
    complete(); await task;
    expect((await workspaceRepository.get(content.id))?.content.name).toBe('B1');
    expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
    expect(await syncLogRepository.list()).toEqual([]);
    expect(server.account(identities[2].url, identities[2].userId).size).toBe(0);
    await login(0);
    expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('synced');
    expect(await syncLogRepository.list()).toHaveLength(1);
  });
  it('keeps a delayed A1 deletion in A1 and never deletes the same ID from B1', async () => {
    await login(0);
    await tombstoneRepository.add({ workspaceId: 'deleted-id', workspaceName: 'A1 deleted', deletedAt: '2026-01-01' });
    for (const index of [0, 2]) {
      const identity = identities[index]!;
      server.account(identity.url, identity.userId).set('deleted-id', { id: 'deleted-id', user_id: identity.userId, name: identity.token });
    }
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    server.beforeRequest = (request) => request.method === 'DELETE' ? gate : undefined;
    const task = syncEngine.syncAll();
    await vi.waitFor(() => expect(server.requests.some((request) => request.method === 'DELETE')).toBe(true));
    await login(2); complete(); await task;
    expect(server.account(identities[2].url, identities[2].userId).has('deleted-id')).toBe(true);
    expect(await tombstoneRepository.list()).toEqual([]);
    expect(await syncLogRepository.list()).toEqual([]);
    await login(0); expect(await tombstoneRepository.has('deleted-id')).toBe(true);
    expect(server.requests.filter((request) => request.method === 'DELETE').every((request) => request.owner === ownerOf(identities[0].url, identities[0].userId))).toBe(true);
  });

});
