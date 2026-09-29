import { friendlySupabaseError, getSupabaseClient } from '@/lib/supabase/client';
import type { CloudWorkspaceRow, WorkspaceContent } from '@/types/workspace';

async function authenticatedClient() {
  const client = await getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session ? { client, userId: data.session.user.id } : null;
}

export const workspaceRemoteRepository = {
  async isAuthenticated(): Promise<boolean> {
    return Boolean(await authenticatedClient());
  },

  async list(): Promise<CloudWorkspaceRow[]> {
    const auth = await authenticatedClient();
    if (!auth) return [];
    const { data, error } = await auth.client.from('workspaces').select('*').order('updated_at', { ascending: false });
    if (error) throw friendlySupabaseError(error);
    return (data ?? []) as CloudWorkspaceRow[];
  },

  async get(id: string): Promise<CloudWorkspaceRow | null> {
    const auth = await authenticatedClient();
    if (!auth) return null;
    const { data, error } = await auth.client.from('workspaces').select('*').eq('id', id).maybeSingle();
    if (error) throw friendlySupabaseError(error);
    return data as CloudWorkspaceRow | null;
  },

  async upsert(content: WorkspaceContent, hash: string): Promise<CloudWorkspaceRow> {
    const auth = await authenticatedClient();
    if (!auth) throw new Error('未登录，当前仅保存在本机');
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
    return data as CloudWorkspaceRow;
  },

  async remove(id: string): Promise<void> {
    const auth = await authenticatedClient();
    if (!auth) throw new Error('未登录');
    const { error } = await auth.client.from('workspaces').delete().eq('id', id);
    if (error) throw friendlySupabaseError(error);
  },
};
