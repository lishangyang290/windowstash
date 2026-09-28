import { describe, expect, it } from 'vitest';
import { validateWorkspaceName } from '@/features/workspaces/workspaceName';

describe('validateWorkspaceName', () => {
  it('trims a valid changed name', () => {
    expect(validateWorkspaceName('  新名称  ', '旧名称')).toEqual({ name: '新名称', error: '', changed: true });
  });

  it('rejects an empty name', () => {
    expect(validateWorkspaceName('   ', '当前名称').error).toBe('请输入工作区名称');
  });

  it('rejects names longer than 50 characters', () => {
    expect(validateWorkspaceName('名'.repeat(51), '当前名称').error).toBe('名称最多 50 个字符');
  });

  it('does not mark the unchanged trimmed name as changed', () => {
    expect(validateWorkspaceName('  当前名称 ', '当前名称')).toEqual({ name: '当前名称', error: '', changed: false });
  });
});
