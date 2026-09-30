export const PASSWORD_REQUIREMENTS = [
  { label: '至少 8 个字符', changeError: '新密码至少需要 8 个字符', test: (password: string) => password.length >= 8 },
  { label: '包含字母', changeError: '新密码需要包含字母', test: (password: string) => /[A-Za-z]/.test(password) },
  { label: '包含数字', changeError: '新密码需要包含数字', test: (password: string) => /\d/.test(password) },
] as const;

export function passwordRequirementsMet(password: string) {
  return PASSWORD_REQUIREMENTS.every(({ test }) => test(password));
}

export function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validateRegistration(email: string, password: string, confirmPassword: string) {
  if (!isValidEmail(email)) return '请输入有效邮箱';
  if (!passwordRequirementsMet(password) || !passwordRequirementsMet(confirmPassword)) return '密码不符合要求';
  if (password !== confirmPassword) return '两次输入的密码不一致';
  return '';
}

export function validatePasswordChange(currentPassword: string, newPassword: string, confirmPassword: string) {
  if (!currentPassword) return '请输入当前密码';
  const failedRequirement = PASSWORD_REQUIREMENTS.find(({ test }) => !test(newPassword));
  if (failedRequirement) return failedRequirement.changeError;
  if (newPassword === currentPassword) return '新密码不能与当前密码相同';
  if (newPassword !== confirmPassword) return '两次输入的新密码不一致';
  return '';
}

export function registrationErrorMessage(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'user_already_exists' || code === 'email_exists') return '邮箱已注册';
  if (code === 'email_address_invalid') return '请输入有效邮箱';
  if (code === 'weak_password') return '密码不符合要求';
  return '注册失败，请稍后重试';
}

export function passwordChangeErrorMessage(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'current_password_invalid' || code === 'current_password_required') return '当前密码不正确';
  if (code === 'weak_password') return '新密码不符合密码要求';
  return '修改失败，请稍后重试';
}
