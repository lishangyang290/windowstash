export interface WorkspaceSummary {
  id: string;
  name: string;
  tabCount: number;
  updatedAt: string;
}

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export type View = 'launcher' | 'settings';
