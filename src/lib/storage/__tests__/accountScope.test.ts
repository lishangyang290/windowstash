import { beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock('wxt/browser', () => ({ browser: { storage: { local: {
  get: vi.fn(async (keys: string | string[] | null) => Object.fromEntries((keys === null ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage.get(key)]))),
  set: vi.fn(async (values: Record<string, unknown>) => Object.entries(values).forEach(([key, value]) => storage.set(key, structuredClone(value)))),
} } } }));
import { selectDataAccount, accountStorageKey, initializeDataAccount } from '../accountScope';
import { workspaceRepository } from '../workspaceRepository';
import { tombstoneRepository } from '../tombstoneRepository';
const content = { id: 'workspace-A', name: 'A pending', status: 'active' as const, tabs: [], activeTabIndex: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
beforeEach(() => storage.clear());
async function activate(url: string, userId: string, migrate = false) {
  storage.set('supabaseConfig', { url, publishableKey: 'fixture' });
  storage.set(`windowstash-auth:sb-${new URL(url).hostname.split('.')[0]}-auth-token`, JSON.stringify({ user: { id: userId } }));
  await selectDataAccount(url, userId, migrate);
}
describe('account storage isolation without data loss', () => {
  it('preserves legacy data, pending changes and tombstones across account/project switches', async () => {
    await workspaceRepository.saveContent(content);
    await tombstoneRepository.add({ workspaceId: 'deleted-A', workspaceName: 'A', deletedAt: '2026-01-01' });
    await activate('https://project1', 'user-A', true);
    const keyA = await accountStorageKey('workspaces');
    const pending = await workspaceRepository.get(content.id);
    await activate('https://project1', 'user-B');
    expect(await workspaceRepository.list()).toEqual([]);
    expect(await tombstoneRepository.list()).toEqual([]);
    await workspaceRepository.put(pending!); // A delayed sync completion cannot write into B.
    expect(await workspaceRepository.list()).toEqual([]);
    expect(storage.has('workspaces')).toBe(true);
    expect(storage.has(keyA)).toBe(true);
    await activate('https://project1', 'user-A', true);
    expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
    expect(await tombstoneRepository.has('deleted-A')).toBe(true);
    await activate('https://project2', 'user-A');
    expect(await workspaceRepository.list()).toEqual([]);
  });
  it('recovers a saved new session but refuses an old account callback', async () => {
    await activate('https://project1', 'user-A', true);
    storage.set('supabaseConfig', { url: 'https://project1', publishableKey: 'fixture' });
    storage.set('windowstash-auth:sb-project1-auth-token', JSON.stringify({ user: { id: 'user-B' } }));
    await initializeDataAccount('https://project1', 'user-B');
    const key = await accountStorageKey('workspaces');
    await expect(initializeDataAccount('https://project1', 'user-A')).rejects.toThrow('账号已变化');
    expect(await accountStorageKey('workspaces')).toBe(key);
  });

});

it('does not automatically assign unowned legacy data to a newly signed-in account', async () => {
  await workspaceRepository.saveContent(content);
  await activate('https://project1', 'user-B');
  expect(await workspaceRepository.list()).toEqual([]);
  expect(storage.has('workspaces')).toBe(true);
});
it('migrates legacy data on startup only with the existing authenticated identity', async () => {
  await workspaceRepository.saveContent(content);
  storage.set('supabaseConfig', { url: 'https://project1', publishableKey: 'fixture' });
  storage.set('windowstash-auth:sb-project1-auth-token', JSON.stringify({ user: { id: 'user-A' } }));
  expect((await workspaceRepository.get(content.id))?.content.name).toBe(content.name);
  storage.delete('windowstash-auth:sb-project1-auth-token');
  expect(await workspaceRepository.list()).toEqual([]);
  storage.set('windowstash-auth:sb-project1-auth-token', JSON.stringify({ user: { id: 'user-B' } }));
  expect(await workspaceRepository.list()).toEqual([]);
  storage.set('windowstash-auth:sb-project1-auth-token', JSON.stringify({ user: { id: 'user-A' } }));
  expect((await workspaceRepository.get(content.id))?.sync.syncStatus).toBe('pending');
});

it('keeps delayed unowned legacy writes in the legacy backup after a new login', async () => {
  const legacy = await workspaceRepository.saveContent(content);
  await activate('https://project1', 'user-B');
  await workspaceRepository.put(legacy);
  expect(await workspaceRepository.list()).toEqual([]);
  expect((storage.get('workspaces') as Record<string, unknown>)[content.id]).toBeTruthy();
});

it('repairs missing scoped data using its known legacy owner, without reintroducing intentionally empty stores', async () => {
  await workspaceRepository.saveContent(content);
  await activate('https://project1', 'user-A', true);
  const key = await accountStorageKey('workspaces');
  storage.delete(key);
  await activate('https://project1', 'user-B'); expect(await workspaceRepository.list()).toEqual([]);
  await activate('https://project1', 'user-A');
  expect((await workspaceRepository.get(content.id))?.content.name).toBe(content.name);
  storage.set(key, {});
  await activate('https://project1', 'user-B'); await activate('https://project1', 'user-A');
  expect(await workspaceRepository.list()).toEqual([]);
});
