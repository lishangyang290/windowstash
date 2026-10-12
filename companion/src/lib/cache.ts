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

export const accountOwner = (url: string, userId: string) => JSON.stringify([new URL(url).href.replace(/\/+$/, ''), userId]);
let accountScope = 'signed-out';
const scoped = (key: string) => accountScope ? `${key}:${accountScope}` : key;
function copyCache(previous: string, next: string, merge: boolean) {
  for (const key of [WORKSPACE_CACHE, RECENT_CACHE]) {
    const source = `${key}${previous ? `:${previous}` : ''}`;
    const target = `${key}:${next}`;
    if (!localStorage.getItem(source) || (!merge && localStorage.getItem(target))) continue;
    const data = key === WORKSPACE_CACHE
      ? [...new Map([...read<WorkspaceSummary[]>(source, []), ...read<WorkspaceSummary[]>(target, [])].map((item) => [item.id, item])).values()]
      : { ...read<Record<string, string>>(source, {}), ...read<Record<string, string>>(target, {}) };
    localStorage.setItem(target, JSON.stringify(data));
  }
}
export const cache = {
  scope(value: string, legacy = false) {
    const marker = 'windowstash-companion:migrated:v2';
    const owner = localStorage.getItem(marker);
    if (legacy && (!owner || owner === value)) {
      copyCache('', value, !owner);
      localStorage.setItem(marker, value);
    }
    accountScope = value;
  },
  migrateScope(previous: string, next: string) {
    const marker = `windowstash-companion:scope-migrated:v2:${previous}`;
    copyCache(previous, next, !localStorage.getItem(marker));
    localStorage.setItem(marker, next);
  },
  currentScope: () => accountScope,
  workspaces: () => read<WorkspaceSummary[]>(scoped(WORKSPACE_CACHE), []),
  saveWorkspaces: (items: WorkspaceSummary[]) => localStorage.setItem(scoped(WORKSPACE_CACHE), JSON.stringify(items)),
  recents: () => read<Record<string, string>>(scoped(RECENT_CACHE), {}),
  markOpened(id: string) {
    localStorage.setItem(scoped(RECENT_CACHE), JSON.stringify({ ...this.recents(), [id]: new Date().toISOString() }));
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
