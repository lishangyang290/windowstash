import type { WorkspaceSummary } from '../types';
import { accountOwner, cache, sortByRecent } from '../lib/cache';
import { currentBrowserGrant } from '../lib/browserAuth';
import { friendlySupabaseError, getSupabaseClient, getSupabaseConfig, getAccountClient } from '../lib/supabase';

interface WorkspaceRow {
  id: string;
  name: string;
  tabs: unknown[] | null;
  updated_at: string;
}

export const workspaceService = {
  cached: () => sortByRecent(cache.workspaces()),
  async refresh(): Promise<WorkspaceSummary[]> {
    const scope = cache.currentScope();
    const config = getSupabaseConfig();
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('请先连接 Supabase');
    const grant = currentBrowserGrant();
    const session = grant?.session ?? (await supabase.auth.getSession()).data.session;
    const url = grant?.config.url ?? config?.url;
    if ((!grant && config?.url !== getSupabaseConfig()?.url) || !session || !url || scope !== accountOwner(url, session.user.id) || scope !== cache.currentScope()) throw new Error('账号已变化，请重新加载工作区');
    const queryClient = grant ? supabase : getAccountClient(config!, session.access_token);
    const { data, error } = await queryClient
      .from('workspaces')
      .select('id,name,tabs,updated_at')
      .eq('user_id', session.user.id)
      .neq('status', 'archived')
      .order('updated_at', { ascending: false });
    if (error) throw friendlySupabaseError(error);
    const items = ((data ?? []) as WorkspaceRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      tabCount: Array.isArray(row.tabs) ? row.tabs.length : 0,
      updatedAt: row.updated_at,
    }));
    if (scope !== cache.currentScope()) throw new Error('账号已变化，请重新加载工作区');
    cache.saveWorkspaces(items);
    return sortByRecent(items);
  },
};
