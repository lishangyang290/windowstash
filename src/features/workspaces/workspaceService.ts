import { browser } from 'wxt/browser';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import { tombstoneRepository } from '@/lib/storage/tombstoneRepository';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import type { BackgroundMessage } from '@/types/messages';
import type { StoredTab, WorkspaceContent, WorkspaceLocalRecord, WorkspaceStatus } from '@/types/workspace';
import { matchWorkspace, type MatchableTab } from './workspaceMatcher';

function requestSync(message: BackgroundMessage): void {
  void browser.runtime.sendMessage(message).catch(() => undefined);
}

async function recordLog(
  workspaceId: string,
  workspaceName: string,
  action: string,
  result: 'success' | 'failed',
  message: string,
) {
  await syncLogRepository.add({ workspaceId, workspaceName, action, result, message });
}

export async function getCurrentWindowSnapshot() {
  const current = await browser.windows.getCurrent({ populate: true });
  if (current.id == null) throw new Error('无法识别当前 Chrome 窗口');
  const tabs = [...(current.tabs ?? [])].sort((a, b) => a.index - b.index);
  return { windowId: current.id, tabs };
}

export async function resolveWorkspaceForWindow(
  windowId: number,
  tabs: MatchableTab[],
): Promise<WorkspaceLocalRecord | null> {
  const boundId = await bindingRepository.get(windowId);
  const bound = boundId ? await workspaceRepository.get(boundId) : null;
  if (bound) return bound;

  const matched = matchWorkspace(tabs, await workspaceRepository.list());
  if (matched) await bindingRepository.set(windowId, matched.content.id);
  return matched;
}

export async function saveCurrentWindow(input: {
  windowId: number;
  name: string;
  status: WorkspaceStatus;
  closeAfterSave: boolean;
}): Promise<WorkspaceContent> {
  const current = await browser.windows.get(input.windowId, { populate: true });
  if (current.id !== input.windowId) throw new Error('当前窗口已不存在');
  const tabs = [...(current.tabs ?? [])].sort((a, b) => a.index - b.index);
  if (!tabs.length) throw new Error('当前窗口没有可保存的标签页');

  const boundId = await bindingRepository.get(input.windowId);
  const previous = boundId ? await workspaceRepository.get(boundId) : null;
  const now = new Date().toISOString();
  const storedTabs: StoredTab[] = tabs.map((tab, position) => ({
    title: tab.title || '未命名标签页',
    url: tab.url || 'about:blank',
    favIconUrl: tab.favIconUrl,
    position,
    pinned: tab.pinned,
  }));
  const activeTabIndex = Math.max(0, tabs.findIndex((tab) => tab.active));
  const content: WorkspaceContent = {
    id: previous?.content.id ?? crypto.randomUUID(),
    name: input.name.trim(),
    status: input.status,
    tabs: storedTabs,
    activeTabIndex,
    createdAt: previous?.content.createdAt ?? now,
    updatedAt: now,
  };

  await workspaceRepository.saveContent(content);
  await bindingRepository.set(input.windowId, content.id);
  await recordLog(content.id, content.name, 'local-save', 'success', 'Local save success');
  requestSync({ type: 'SYNC_WORKSPACE', workspaceId: content.id });

  if (input.closeAfterSave) await browser.windows.remove(input.windowId);
  return content;
}

export async function restoreWorkspace(workspaceId: string): Promise<number> {
  const record = await workspaceRepository.get(workspaceId);
  if (!record) throw new Error('本地工作区不存在，请先完成云端同步');
  const createdWindow = await browser.windows.create({ url: 'about:blank', focused: true });
  if (!createdWindow || createdWindow.id == null) throw new Error('无法创建新的 Chrome 窗口');
  const initialTabId = createdWindow.tabs?.[0]?.id;
  const createdByPosition = new Map<number, number>();

  for (const tab of [...record.content.tabs].sort((a, b) => a.position - b.position)) {
    try {
      const created = await browser.tabs.create({
        windowId: createdWindow.id,
        url: tab.url,
        active: false,
        pinned: tab.pinned,
      });
      if (created.id != null) createdByPosition.set(tab.position, created.id);
    } catch (error) {
      await recordLog(
        workspaceId,
        record.content.name,
        'restore-tab',
        'failed',
        `${tab.url}: ${error instanceof Error ? error.message : '无法打开'}`,
      );
    }
  }

  if (initialTabId != null && createdByPosition.size > 0) await browser.tabs.remove(initialTabId).catch(() => undefined);
  const activeTabId = createdByPosition.get(record.content.activeTabIndex) ?? [...createdByPosition.values()][0];
  if (activeTabId != null) await browser.tabs.update(activeTabId, { active: true });
  await bindingRepository.set(createdWindow.id, workspaceId);
  await workspaceRepository.put({
    ...record,
    sync: { ...record.sync, localExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
  });
  await recordLog(workspaceId, record.content.name, 'restore', 'success', 'Workspace restored');
  return createdWindow.id;
}

export async function openWorkspaceTab(url: string): Promise<void> {
  await browser.tabs.create({ url, active: true });
}

export async function focusWindowTab(windowId: number, tabId: number): Promise<void> {
  await browser.tabs.update(tabId, { active: true });
  await browser.windows.update(windowId, { focused: true });
}

export async function reopenSavedTab(windowId: number, tab: StoredTab): Promise<void> {
  await browser.tabs.create({
    windowId,
    url: tab.url,
    active: true,
    index: tab.position,
    pinned: tab.pinned,
  });
}

export async function updateWorkspace(
  workspaceId: string,
  patch: Partial<Pick<WorkspaceContent, 'name' | 'status'>>,
): Promise<void> {
  const record = await workspaceRepository.get(workspaceId);
  if (!record) throw new Error('工作区不存在');
  await workspaceRepository.saveContent({ ...record.content, ...patch, updatedAt: new Date().toISOString() });
  requestSync({ type: 'SYNC_WORKSPACE', workspaceId });
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const record = await workspaceRepository.get(workspaceId);
  if (!record) return;
  await tombstoneRepository.add({
    workspaceId,
    workspaceName: record.content.name,
    deletedAt: new Date().toISOString(),
  });
  await workspaceRepository.remove(workspaceId);
  requestSync({ type: 'SYNC_ALL' });
}
