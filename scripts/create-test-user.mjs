import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL?.trim();
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const email = process.env.WINDOWSTASH_TEST_EMAIL?.trim();
const password = process.env.WINDOWSTASH_TEST_PASSWORD;

if (!url || !key) {
  console.error('缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_PUBLISHABLE_KEY。');
  process.exit(1);
}

if (!email || !password) {
  console.error('请通过临时环境变量提供 WINDOWSTASH_TEST_EMAIL 和 WINDOWSTASH_TEST_PASSWORD。');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const { data, error } = await supabase.auth.signUp({ email, password });

if (error) {
  if (/already (registered|exists)|user.*exists/i.test(error.message)) {
    console.log(JSON.stringify({ status: 'already_exists', email }, null, 2));
    process.exit(0);
  }
  console.error(`创建失败：${error.message}`);
  process.exit(1);
}

const user = data.user;
if (!user) {
  console.error('创建失败：Supabase 未返回 user。');
  process.exit(1);
}

if (Array.isArray(user.identities) && user.identities.length === 0) {
  console.log(JSON.stringify({ status: 'already_exists', email: user.email ?? email }, null, 2));
  process.exit(0);
}

const confirmed = Boolean(user.email_confirmed_at ?? user.confirmed_at);
const requiresEmailConfirmation = !data.session && !confirmed;

console.log(JSON.stringify({
  status: 'created',
  email: user.email ?? email,
  userId: user.id,
  userReturned: true,
  confirmed,
  requiresEmailConfirmation,
  canLoginNow: Boolean(data.session) || confirmed,
}, null, 2));

if (requiresEmailConfirmation) {
  console.log('账号已创建，需要去邮箱点击验证链接。');
}
