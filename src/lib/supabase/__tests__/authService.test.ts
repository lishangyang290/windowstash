vi.mock('@/lib/storage/accountScope', () => ({ dataAccountLock: async (task: () => Promise<unknown>) => task(), dataAccountHidden: vi.fn(async () => false), hideDataAccount: vi.fn(), initializeDataAccount: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({
  updateUser: vi.fn(), signOut: vi.fn(), getSession: vi.fn(),
}));

const native = vi.hoisted(() => vi.fn());
const configState = vi.hoisted(() => ({ config: null as { url: string; publishableKey: string } | null }));
vi.mock('@/lib/companion/auth', () => ({ authLock: async (task: () => Promise<unknown>) => task(), authLink: async () => ({ capability: 'fixture' }), nativeAuth: native }));

vi.mock('@/lib/supabase/client', () => ({ getSupabaseConfig: async () => configState.config, getSupabaseClient: async () => ({ auth: authMock }) }));

import { dataAccountHidden } from '@/lib/storage/accountScope';
import { authService } from '@/lib/supabase/authService';

describe('authService password change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.updateUser.mockResolvedValue({ error: null });
  });

  it('updates the current user password with the current password', async () => {
    await authService.updatePassword('current-password', 'new-password');
    expect(authMock.updateUser).toHaveBeenCalledWith({ current_password: 'current-password', password: 'new-password' });
  });

  it('passes update errors to the form without another auth flow', async () => {
    const error = { code: 'current_password_invalid' };
    authMock.updateUser.mockResolvedValue({ error });
    await expect(authService.updatePassword('wrong-password', 'Password1')).rejects.toBe(error);
    expect(authMock.updateUser).toHaveBeenCalledTimes(1);
  });
});


it('notifies Companion when Chrome signs out without touching local workspace storage', async () => {
  authMock.getSession.mockResolvedValue({ data: { session: null } });
  authMock.signOut.mockResolvedValue({ error: null });
  native.mockResolvedValue(undefined);
  vi.mocked(dataAccountHidden).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
  await authService.signOut();
  expect(authMock.signOut).toHaveBeenCalled();
  expect(native).toHaveBeenCalledWith('clear');
});

it('requires a session for manager operations', async () => {
  authMock.getSession.mockResolvedValue({ data: { session: null } });
  await expect(authService.requireSession()).rejects.toThrow('请先登录');
});

it('keeps an explicitly signed-out account hidden even if the SDK still has a cached session', async () => {
  vi.mocked(dataAccountHidden).mockResolvedValueOnce(true);
  authMock.getSession.mockResolvedValue({ data: { session: { user: { id: 'A' } } } });
  authMock.getSession.mockClear();
  expect(await authService.session()).toBeNull();
  expect(authMock.getSession).not.toHaveBeenCalled();
});
it('does not clear a newer shared login when an older logout completes late', async () => {
  native.mockClear();
  authMock.signOut.mockClear();
  authMock.signOut.mockResolvedValue({ error: null });
  vi.mocked(dataAccountHidden).mockResolvedValueOnce(false);
  await authService.signOut();
  expect(native).not.toHaveBeenCalledWith('clear');
  expect(authMock.signOut).not.toHaveBeenCalled();
});

describe('verified native offline identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.config = { url: 'https://fixture.supabase.co', publishableKey: 'fixture' };
    vi.mocked(dataAccountHidden).mockResolvedValue(false);
  });
  it('uses an authorized expired session without asking the cloud SDK to refresh', async () => {
    native.mockResolvedValue({ config: { url: configState.config!.url }, session: { user: { id: 'A' }, expires_at: 0 } });
    authMock.getSession.mockRejectedValue(new Error('Network offline'));
    expect((await authService.session())?.user.id).toBe('A');
    expect(native).toHaveBeenCalledWith('local');
    expect(authMock.getSession).not.toHaveBeenCalled();
  });
  it('refuses a native identity from a different project', async () => {
    native.mockResolvedValue({ config: { url: 'https://other.supabase.co' }, session: { user: { id: 'B' } } });
    expect(await authService.session()).toBeNull();
  });
});
