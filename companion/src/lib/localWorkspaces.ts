import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceSummary } from '../types';

export interface LocalWorkspaces {
  instance_id: string;
  project_url: string;
  user_id: string;
  revision: number;
  items: WorkspaceSummary[];
}
export const readLocalWorkspaces = () => invoke<LocalWorkspaces | null>('local_workspaces');
