import { dataAccountLock, dataAccountHidden, hideDataAccount, initializeDataAccount, selectDataAccount } from '@/lib/storage/accountScope';
import { authLink, authLock, nativeAuth } from '@/lib/companion/auth';
import { getSupabaseConfig } from '@/lib/supabase/client';
import { friendlySupabaseError, getSupabaseClient } from '@/lib/supabase/client';

async function requireClient() {
  const client = await getSupabaseClient();
  if (!client) throw new Error('请先连接 Supabase');
  return client;
}

async function preservePreviousAccount(client: Awaited<ReturnType<typeof requireClient>>) {
  const { data } = await client.auth.getSession();
  const config = await getSupabaseConfig();
  if (data.session && config) await initializeDataAccount(config.url, data.session.user.id);
}

async function verifySchema(client: Awaited<ReturnType<typeof requireClient>>) {
  const { error } = await client.from('workspaces').select('id').limit(1);
  if (error) throw friendlySupabaseError(error);
}

export const authService = {
  async requireSession() {
    const session = await this.session();
    if (!session) throw new Error('请先登录 WindowStash');
    return session;
  },
  async subscribe(changed: () => void) {
    const client = await getSupabaseClient();
    const subscription = client?.auth.onAuthStateChange((event) => {
      if (event !== 'INITIAL_SESSION') changed();
    }).data.subscription;
    return () => subscription?.unsubscribe();
  },
  async session() {
    if (await dataAccountHidden()) return null;
    const client = await getSupabaseClient();
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (await dataAccountHidden()) return null;
    if (data.session) {
      const config = await getSupabaseConfig();
      if (config) await initializeDataAccount(config.url, data.session.user.id);
    } else await hideDataAccount();
    return await dataAccountHidden() ? null : data.session;
  },
  async signIn(email: string, password: string) {
    const client = await requireClient();
    await preservePreviousAccount(client);
    const loginConfig = await getSupabaseConfig();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data.session) {
      const session = data.session;
      if (loginConfig?.url !== (await getSupabaseConfig())?.url) throw new Error('Supabase 项目已变化，请重新登录');
      await authLock(async () => {
        if (await authLink()) {
          const config = await getSupabaseConfig();
          if (!config) throw new Error('请先连接 Supabase');
          await nativeAuth('replace', { config: { url: config.url, publishable_key: config.publishableKey }, session });
        }
        const config = await getSupabaseConfig();
        if (config) await selectDataAccount(config.url, session.user.id);
      });
      await verifySchema(client);
    }
    return data.session;
  },
  async signUp(email: string, password: string) {
    const client = await requireClient();
    await preservePreviousAccount(client);
    const loginConfig = await getSupabaseConfig();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    if (data.session) {
      const session = data.session;
      if (loginConfig?.url !== (await getSupabaseConfig())?.url) throw new Error('Supabase 项目已变化，请重新登录');
      await authLock(async () => {
        if (await authLink()) {
          const config = await getSupabaseConfig();
          if (!config) throw new Error('请先连接 Supabase');
          await nativeAuth('replace', { config: { url: config.url, publishable_key: config.publishableKey }, session });
        }
        const config = await getSupabaseConfig();
        if (config) await selectDataAccount(config.url, session.user.id);
      });
      await verifySchema(client);
    }
    return data.session;
  },
  async signOut() {
    await hideDataAccount();
    const client = await requireClient();
    const { error } = await client.auth.signOut();
    if (error) throw error;
    await authLock(() => dataAccountLock(async () => {
      // A late logout must not clear a newer browser/desktop login.
      if (await dataAccountHidden() && await authLink()) await nativeAuth('clear');
    }));
  },
  async updatePassword(currentPassword: string, password: string) {
    const { error } = await (await requireClient()).auth.updateUser({ current_password: currentPassword, password });
    if (error) throw error;
  },
};
