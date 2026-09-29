export const MAX_WORKSPACE_NAME_LENGTH = 50;

export function validateWorkspaceName(value: string, currentName: string) {
  const name = value.trim();
  if (!name) return { name, error: '请输入工作区名称', changed: false };
  if (Array.from(name).length > MAX_WORKSPACE_NAME_LENGTH) {
    return { name, error: '名称最多 50 个字符', changed: false };
  }
  return { name, error: '', changed: name !== currentName };
}
