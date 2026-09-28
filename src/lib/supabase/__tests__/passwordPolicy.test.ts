import { describe, expect, it } from 'vitest';
import { PASSWORD_REQUIREMENTS, passwordChangeErrorMessage, validatePasswordChange } from '@/lib/supabase/passwordPolicy';

describe('password change policy', () => {
  it('checks the three fixed requirements in real time', () => {
    expect(PASSWORD_REQUIREMENTS.map(({ test }) => test('abc'))).toEqual([false, true, false]);
    expect(PASSWORD_REQUIREMENTS.map(({ test }) => test('12345678'))).toEqual([true, false, true]);
    expect(PASSWORD_REQUIREMENTS.map(({ test }) => test('Password1'))).toEqual([true, true, true]);
  });

  it.each([
    ['', 'Password1', 'Password1', '请输入当前密码'],
    ['Current1', 'Pass1', 'Pass1', '新密码至少需要 8 个字符'],
    ['Current1', '12345678', '12345678', '新密码需要包含字母'],
    ['Current1', 'Password', 'Password', '新密码需要包含数字'],
    ['Password1', 'Password1', 'Password1', '新密码不能与当前密码相同'],
    ['Current1', 'Password1', 'Password2', '两次输入的新密码不一致'],
    ['Current1', 'Password1', 'Password1', ''],
  ])('validates current=%j new=%j confirm=%j', (currentPassword, newPassword, confirmPassword, expected) => {
    expect(validatePasswordChange(currentPassword, newPassword, confirmPassword)).toBe(expected);
  });

  it.each([
    ['current_password_invalid', '当前密码不正确'],
    ['current_password_required', '当前密码不正确'],
    ['weak_password', '新密码不符合密码要求'],
    ['unexpected_error', '修改失败，请稍后重试'],
  ])('maps %s without exposing server details', (code, expected) => {
    expect(passwordChangeErrorMessage({ code, message: 'technical server details' })).toBe(expected);
  });
});
