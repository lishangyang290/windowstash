import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), key: 'workspaces:["https://project","B"]', session: vi.fn(), from: vi.fn(), local: vi.fn() }));
vi.mock('@/lib/storage/accountScope', () => ({ dataAccountHidden: async () => false, accountOwner: (url: string, id: string) => JSON.stringify([url, id]), accountStorageKey: async () => mocks.key, initializeDataAccount: vi.fn() }));
vi.mock('@/lib/storage/workspaceRepository', () => ({ workspaceRepository: { get: mocks.local } }));
vi.mock('@/lib/supabase/client', () => ({ getSupabaseConfig: async () => ({ url: 'https://project', publishableKey: 'fixture' }), getSupabaseClient: async () => ({ auth: { getSession: mocks.session }, from: mocks.from }), friendlySupabaseError: (error: unknown) => error }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
import { workspaceRemoteRepository } from '../workspaceRemoteRepository';
const content = { id: 'same-id', name: 'A pending', tabs: [], status: 'active' as const, activeTabIndex: 0, createdAt: '', updatedAt: '' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReturnValue({ from: mocks.from });
  mocks.key = 'workspaces:["https://project","B"]';
  mocks.session.mockResolvedValue({ data: { session: { access_token: 'B-token', user: { id: 'B' } } } });
  mocks.local.mockResolvedValue({ content });
});
describe('cloud account boundaries', () => {
  it('refuses an old account upload even if the new account has the same workspace ID', async () => {
    await expect(workspaceRemoteRepository.upsert(content, 'hash', 'workspaces:["https://project","A"]')).rejects.toThrow('其他账号');
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('refuses a previous project pending upload', async () => {
    await expect(workspaceRemoteRepository.upsert(content, 'hash', 'workspaces:["https://old-project","B"]')).rejects.toThrow('其他账号');
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('does not upload while signed out', async () => {
    mocks.session.mockResolvedValue({ data: { session: null } });
    await expect(workspaceRemoteRepository.upsert(content, 'hash', mocks.key)).rejects.toThrow('未登录');
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('filters downloads by the authenticated user and tags the original cache scope', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn(async () => ({ data: [{ id: 'B-workspace', user_id: 'B' }] })) };
    mocks.from.mockReturnValue(query);
    expect(await workspaceRemoteRepository.list()).toEqual([{ id: 'B-workspace', user_id: 'B', accountStorageKey: mocks.key }]);
    expect(query.eq).toHaveBeenCalledWith('user_id', 'B');
  });
  it('preserves a pending delete if the account changes during the request', async () => {
    const query = { delete: vi.fn().mockReturnThis(), eq: vi.fn() };
    query.eq.mockReturnValueOnce(query).mockImplementationOnce(async () => {
      mocks.key = 'workspaces:["https://project","C"]';
      return { error: null };
    });
    mocks.from.mockReturnValue(query);
    await expect(workspaceRemoteRepository.remove('B-workspace', 'deleteTombstones:["https://project","B"]')).rejects.toThrow('删除记录仍保留');
  });

});

it('pins cloud requests to the captured token when the shared SDK session changes', async () => {
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn(async () => {
    mocks.key = 'workspaces:["https://project","C"]';
    mocks.session.mockResolvedValue({ data: { session: { access_token: 'C-token', user: { id: 'C' } } } });
    const options = mocks.create.mock.calls[0]![2];
    expect(await options.accessToken()).toBe('B-token');
    return { data: [{ id: 'B-workspace', user_id: 'B' }] };
  }) };
  mocks.from.mockReturnValue(query);
  expect((await workspaceRemoteRepository.list())[0]!.accountStorageKey).toBe('workspaces:["https://project","B"]');
});
it('refuses unscoped upload content even when the active account has the same ID', async () => {
  await expect(workspaceRemoteRepository.upsert(content, 'hash')).rejects.toThrow('其他账号');
  expect(mocks.from).not.toHaveBeenCalled();
});
