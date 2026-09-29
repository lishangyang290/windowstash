import type { SupabaseConfig, WorkspaceSummary } from '../types';

const WORKSPACE_CACHE = 'windowstash-companion:workspaces:v1';
const RECENT_CACHE = 'windowstash-companion:recent:v1';
const EXTENSION_ID = 'windowstash-companion:extension-id:v1';
const SUPABASE_CONFIG = 'windowstash-companion:supabase-config:v1';

function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

export const cache = {
  workspaces: () => read<WorkspaceSummary[]>(WORKSPACE_CACHE, []),
  saveWorkspaces: (items: WorkspaceSummary[]) => localStorage.setItem(WORKSPACE_CACHE, JSON.stringify(items)),
  recents: () => read<Record<string, string>>(RECENT_CACHE, {}),
  markOpened(id: string) {
    localStorage.setItem(RECENT_CACHE, JSON.stringify({ ...this.recents(), [id]: new Date().toISOString() }));
  },
  extensionId: () => localStorage.getItem(EXTENSION_ID),
  saveExtensionId: (id: string) => localStorage.setItem(EXTENSION_ID, id),
  clearExtensionId: () => localStorage.removeItem(EXTENSION_ID),
  supabaseConfig: () => read<SupabaseConfig | null>(SUPABASE_CONFIG, null),
  saveSupabaseConfig: (config: SupabaseConfig) => localStorage.setItem(SUPABASE_CONFIG, JSON.stringify(config)),
};

export function sortByRecent(items: WorkspaceSummary[]): WorkspaceSummary[] {
  const recent = cache.recents();
  return [...items].sort((a, b) => {
    const aRecent = recent[a.id];
    const bRecent = recent[b.id];
    if (aRecent || bRecent) return (bRecent ? Date.parse(bRecent) : 0) - (aRecent ? Date.parse(aRecent) : 0);
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}
