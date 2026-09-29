import { friendlySupabaseError, getSupabaseClient } from '@/lib/supabase/client';

async function requireClient() {
  const client = await getSupabaseClient();
  if (!client) throw new Error('请先连接 Supabase');
  return client;
}

async function verifySchema(client: Awaited<ReturnType<typeof requireClient>>) {
  const { error } = await client.from('workspaces').select('id').limit(1);
  if (error) throw friendlySupabaseError(error);
}

export const authService = {
  async session() {
    const client = await getSupabaseClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session;
  },
  async signIn(email: string, password: string) {
    const client = await requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data.session) await verifySchema(client);
    return data.session;
  },
  async signUp(email: string, password: string) {
    const client = await requireClient();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    if (data.session) await verifySchema(client);
    return data.session;
  },
  async signOut() {
    const { error } = await (await requireClient()).auth.signOut();
    if (error) throw error;
  },
  async updatePassword(currentPassword: string, password: string) {
    const { error } = await (await requireClient()).auth.updateUser({ current_password: currentPassword, password });
    if (error) throw error;
  },
};
