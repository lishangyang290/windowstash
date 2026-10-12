import { invoke } from '@tauri-apps/api/core';

export interface ChromeTarget { profile: string; extension_id: string }
export interface ChromeConnection {
  targets: ChromeTarget[];
  selected: { target: ChromeTarget; route_id: string; instance_id: string | null } | null;
  error: string | null;
  host_error: string | null;
  last_received_at: number | null;
}

async function connection() { return invoke<ChromeConnection>('discover_chrome_targets'); }
async function open(page: 'launcher' | 'options', workspaceId: string | null) {
  const status = await connection();
  if (!status.selected) throw new Error(status.error ?? '请先选择 Chrome Profile');
  const target = status.selected.target;
  await invoke('open_chrome_page', { extensionId: target.extension_id, profile: target.profile, page, workspaceId });
}

export const chromeBridge = {
  connection,
  select: (target: ChromeTarget) => invoke<ChromeConnection>('select_chrome_target', { profile: target.profile, extensionId: target.extension_id }),
  openWorkspace: (workspaceId: string) => open('launcher', workspaceId),
  openManager: () => open('options', null),
};
