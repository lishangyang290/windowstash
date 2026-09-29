import type { WorkspaceSummary } from '../types';
import { cache, sortByRecent } from '../lib/cache';
import { supabase } from '../lib/supabase';

interface WorkspaceRow {
  id: string;
  name: string;
  tabs: unknown[] | null;
  updated_at: string;
}

export const workspaceService = {
  cached: () => sortByRecent(cache.workspaces()),
  async refresh(): Promise<WorkspaceSummary[]> {
    if (!supabase) throw new Error('Companion 尚未配置 Supabase');
    const { data, error } = await supabase
      .from('workspaces')
      .select('id,name,tabs,updated_at')
      .neq('status', 'archived')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    const items = ((data ?? []) as WorkspaceRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      tabCount: Array.isArray(row.tabs) ? row.tabs.length : 0,
      updatedAt: row.updated_at,
    }));
    cache.saveWorkspaces(items);
    return sortByRecent(items);
  },
};
