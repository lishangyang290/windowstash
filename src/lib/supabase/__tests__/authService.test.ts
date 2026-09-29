import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({
  updateUser: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({ getSupabaseClient: () => ({ auth: authMock }) }));

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
