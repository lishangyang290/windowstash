import { getSupabaseClient } from '@/lib/supabase/client';

function requireClient() {
  const client = getSupabaseClient();
  if (!client) throw new Error('请先在 .env 中配置 Supabase URL 和 Publishable Key');
  return client;
}

export const authService = {
  async session() {
    const client = getSupabaseClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session;
  },
  async signIn(email: string, password: string) {
    const { data, error } = await requireClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  },
  async signUp(email: string, password: string) {
    const { data, error } = await requireClient().auth.signUp({ email, password });
    if (error) throw error;
    return data.session;
  },
  async signOut() {
    const { error } = await requireClient().auth.signOut();
    if (error) throw error;
  },
  async updatePassword(currentPassword: string, password: string) {
    const { error } = await requireClient().auth.updateUser({ current_password: currentPassword, password });
    if (error) throw error;
  },
};
