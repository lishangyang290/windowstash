import { invoke } from '@tauri-apps/api/core';
import { cache } from './cache';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

async function extensionId(): Promise<string | null> {
  const saved = cache.extensionId();
  if (saved && EXTENSION_ID_PATTERN.test(saved)) return saved;
  const detected = await invoke<string | null>('discover_extension_id');
  if (detected) cache.saveExtensionId(detected);
  return detected;
}

export const chromeBridge = {
  extensionId,
  isValidExtensionId: (value: string) => EXTENSION_ID_PATTERN.test(value.trim()),
  connect(value: string) {
    const id = value.trim();
    if (!EXTENSION_ID_PATTERN.test(id)) throw new Error('请输入有效的 Chrome 扩展 ID');
    cache.saveExtensionId(id);
  },
  disconnect: cache.clearExtensionId,
  async openWorkspace(workspaceId: string) {
    const id = await extensionId();
    if (!id) throw new Error('请先连接 Chrome 扩展');
    await invoke('open_chrome_page', { extensionId: id, page: 'launcher', workspaceId });
  },
  async openManager() {
    const id = await extensionId();
    if (!id) throw new Error('请先连接 Chrome 扩展');
    await invoke('open_chrome_page', { extensionId: id, page: 'options', workspaceId: null });
  },
};
