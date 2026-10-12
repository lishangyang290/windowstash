import { createClient } from '@supabase/supabase-js';
import { dataAccountHidden, accountOwner, accountStorageKey } from '@/lib/storage/accountScope';
import { STORAGE_KEYS } from '@/lib/constants';
import { initializeDataAccount } from '@/lib/storage/accountScope';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { getSupabaseConfig } from './client';
import { friendlySupabaseError, getSupabaseClient } from '@/lib/supabase/client';
import type { CloudWorkspaceRow, WorkspaceContent } from '@/types/workspace';

async function authenticatedClient(expectedKey?: string) {
  if (await dataAccountHidden()) return null;
  const config = await getSupabaseConfig();
  const client = await getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (data.session) {
    if (config) await initializeDataAccount(config.url, data.session.user.id);
  }
  if (!data.session || !config || await dataAccountHidden()) return null;
  const storageKey = await accountStorageKey(STORAGE_KEYS.workspaces);
  if (storageKey !== `${STORAGE_KEYS.workspaces}:${accountOwner(config.url, data.session.user.id)}`) throw new Error('账号已变化，请重新加载后再同步');
  if (expectedKey && expectedKey !== storageKey) throw new Error('工作区属于其他账号，删除记录仍保留');
  const token = data.session.access_token;
  const scopedClient = createClient(config.url, config.publishableKey, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { client: scopedClient, userId: data.session.user.id, storageKey };
}

export const workspaceRemoteRepository = {
  async isAuthenticated(): Promise<boolean> {
    return Boolean(await authenticatedClient());
  },

  async list(expectedKey?: string): Promise<CloudWorkspaceRow[]> {
    const auth = await authenticatedClient(expectedKey);
    if (!auth) return [];
    const { data, error } = await auth.client.from('workspaces').select('*').eq('user_id', auth.userId).order('updated_at', { ascending: false });
    if (error) throw friendlySupabaseError(error);
    return ((data ?? []) as CloudWorkspaceRow[]).map((row) => ({ ...row, accountStorageKey: auth.storageKey }));
  },

  async get(id: string, expectedKey?: string): Promise<CloudWorkspaceRow | null> {
    const auth = await authenticatedClient(expectedKey);
    if (!auth) return null;
    const { data, error } = await auth.client.from('workspaces').select('*').eq('user_id', auth.userId).eq('id', id).maybeSingle();
    if (error) throw friendlySupabaseError(error);
    return data ? { ...data, accountStorageKey: auth.storageKey } as CloudWorkspaceRow : null;
  },

  async upsert(content: WorkspaceContent, hash: string, storageKey?: string): Promise<CloudWorkspaceRow> {
    const auth = await authenticatedClient(storageKey);
    if (!auth) throw new Error('未登录，当前仅保存在本机');
    if ((storageKey !== auth.storageKey) || !await workspaceRepository.get(content.id, auth.storageKey)) throw new Error('工作区属于其他账号，已保留在本机');
    const { data, error } = await auth.client
      .from('workspaces')
      .upsert({
        id: content.id,
        user_id: auth.userId,
        name: content.name,
        status: content.status,
        tabs: content.tabs,
        active_tab_index: content.activeTabIndex,
        content_hash: hash,
        created_at: content.createdAt,
      })
      .select('*')
      .single();
    if (error) throw friendlySupabaseError(error);
    return { ...data, accountStorageKey: auth.storageKey } as CloudWorkspaceRow;
  },

  async remove(id: string, tombstoneKey?: string): Promise<void> {
    const auth = await authenticatedClient(tombstoneKey?.replace(/^deleteTombstones/, 'workspaces'));
    if (!auth) throw new Error('未登录');
    if (!tombstoneKey || tombstoneKey !== await accountStorageKey(STORAGE_KEYS.tombstones)) throw new Error('账号已变化，删除记录仍保留');
    const { error } = await auth.client.from('workspaces').delete().eq('user_id', auth.userId).eq('id', id);
    if (error) throw friendlySupabaseError(error);
    if (await accountStorageKey(STORAGE_KEYS.workspaces) !== auth.storageKey) throw new Error('账号已变化，删除记录仍保留');
  },
};
