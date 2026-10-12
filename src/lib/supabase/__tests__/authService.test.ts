vi.mock('@/lib/storage/accountScope', () => ({ dataAccountLock: async (task: () => Promise<unknown>) => task(), dataAccountHidden: vi.fn(async () => false), hideDataAccount: vi.fn(), initializeDataAccount: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({
  updateUser: vi.fn(), signOut: vi.fn(), getSession: vi.fn(),
}));

const native = vi.hoisted(() => vi.fn());
vi.mock('@/lib/companion/auth', () => ({ authLock: async (task: () => Promise<unknown>) => task(), authLink: async () => ({ capability: 'fixture' }), nativeAuth: native }));

vi.mock('@/lib/supabase/client', () => ({ getSupabaseConfig: async () => null, getSupabaseClient: async () => ({ auth: authMock }) }));

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
  vi.mocked(dataAccountHidden).mockResolvedValueOnce(true);
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
  authMock.signOut.mockResolvedValue({ error: null });
  vi.mocked(dataAccountHidden).mockResolvedValueOnce(false);
  await authService.signOut();
  expect(native).not.toHaveBeenCalledWith('clear');
});
