import { browser } from 'wxt/browser';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import { tombstoneRepository } from '@/lib/storage/tombstoneRepository';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import type { BackgroundMessage } from '@/types/messages';
import type { StoredTab, WorkspaceContent, WorkspaceLocalRecord, WorkspaceStatus } from '@/types/workspace';
import { syncEngine } from '@/lib/sync/syncEngine';
import { matchWorkspace, MIN_CANDIDATE_GAP, scoreWorkspaceMatch, type MatchableTab } from './workspaceMatcher';
import {
  canLazyRestore,
  createLazyEntry,
  lazyTabUrl,
  resolveLazyMatchableTab,
  resolveLazyStoredTab,
} from './lazyRestore';
import { lazyRestoreRepository } from '@/lib/storage/lazyRestoreRepository';

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

  const matched = matchWorkspace(await Promise.all(tabs.map(resolveLazyMatchableTab)), await workspaceRepository.list());
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
  const storedTabs: StoredTab[] = await Promise.all(tabs.map((tab, position) => resolveLazyStoredTab(tab, position)));
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
      let created;
      if (canLazyRestore(tab, record.content.activeTabIndex)) {
        const entry = createLazyEntry(workspaceId, tab);
        try {
          await lazyRestoreRepository.put(entry);
          created = await browser.tabs.create({ windowId: createdWindow.id, url: lazyTabUrl(entry.id), active: false, pinned: tab.pinned });
          await lazyRestoreRepository.put({ ...entry, tabId: created.id, windowId: createdWindow.id });
        } catch {
          await lazyRestoreRepository.remove(entry.id).catch(() => undefined);
          created = await browser.tabs.create({ windowId: createdWindow.id, url: tab.url, active: false, pinned: tab.pinned });
        }
      } else {
        created = await browser.tabs.create({ windowId: createdWindow.id, url: tab.url, active: false, pinned: tab.pinned });
      }
      if (created.id != null) createdByPosition.set(tab.position, created.id);
    } catch (error) {
      await recordLog(
        workspaceId,
        record.content.name,
        'restore-tab',
        'failed',
        `Tab ${tab.position}: ${error instanceof Error ? error.message : '无法打开'}`,
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

interface WindowCandidate {
  windowId: number;
  beforeTabs: number;
  afterTabs: number;
  bindingMatched: boolean;
  score: number | null;
  eligible: boolean;
}

const openWorkspaceTasks = new Map<string, Promise<number>>();

function isInternalTab(tab: MatchableTab): boolean {
  const extensionRoot = browser.runtime.getURL('/');
  return [tab.url, tab.pendingUrl].some((url) => url?.startsWith(extensionRoot));
}

async function logLaunch(
  record: WorkspaceLocalRecord,
  result: 'focus-existing' | 'rebind-and-focus' | 'restore-new' | 'ambiguous',
  candidates: WindowCandidate[],
): Promise<void> {
  const ranked = candidates.filter((candidate) => candidate.score != null).sort((a, b) => b.score! - a.score!);
  await syncLogRepository.add({
    workspaceId: record.content.id,
    workspaceName: record.content.name,
    action: 'workspace-launch',
    result: 'info',
    message: JSON.stringify({
      workspaceId: record.content.id,
      candidates,
      bestCandidate: ranked[0]?.windowId ?? null,
      secondBestCandidate: ranked[1]?.windowId ?? null,
      result,
    }),
  });
}

async function runOpenOrFocusWorkspace(workspaceId: string): Promise<number> {
  let record = await workspaceRepository.get(workspaceId);
  if (!record) {
    await syncEngine.syncAll();
    record = await workspaceRepository.get(workspaceId);
  }
  if (!record) throw new Error('工作区不存在或尚未同步');

  const windows = await browser.windows.getAll({ populate: true });
  const candidates: WindowCandidate[] = [];
  for (const window of windows) {
    if (window.id != null && await bindingRepository.get(window.id) === workspaceId) {
      candidates.push({ windowId: window.id, beforeTabs: window.tabs?.length ?? 0, afterTabs: window.tabs?.length ?? 0, bindingMatched: true, score: null, eligible: true });
      await logLaunch(record, 'focus-existing', candidates).catch(() => undefined);
      await browser.windows.update(window.id, { focused: true });
      return window.id;
    }
  }
  for (const window of windows) {
    if (window.id == null) continue;
    const resolvedTabs = await Promise.all((window.tabs ?? []).map(resolveLazyMatchableTab));
    const tabs = resolvedTabs.filter((tab) => !isInternalTab(tab));
    const match = scoreWorkspaceMatch(tabs, record);
    candidates.push({ windowId: window.id, beforeTabs: window.tabs?.length ?? 0, afterTabs: tabs.length, bindingMatched: false, score: match.score, eligible: match.eligible });
  }
  const ranked = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = ranked[0];
  const second = ranked[1];
  if (best?.eligible && second && (best.score ?? 0) - (second.score ?? 0) < MIN_CANDIDATE_GAP) {
    await logLaunch(record, 'ambiguous', candidates).catch(() => undefined);
    throw new Error('找到多个相似的 Workspace 窗口，已取消自动恢复');
  }
  if (best?.eligible) {
    await bindingRepository.set(best.windowId, workspaceId);
    await logLaunch(record, 'rebind-and-focus', candidates).catch(() => undefined);
    await browser.windows.update(best.windowId, { focused: true });
    return best.windowId;
  }
  await logLaunch(record, 'restore-new', candidates).catch(() => undefined);
  return restoreWorkspace(workspaceId);
}

export function openOrFocusWorkspace(workspaceId: string): Promise<number> {
  const existing = openWorkspaceTasks.get(workspaceId);
  if (existing) return existing;
  const task = runOpenOrFocusWorkspace(workspaceId).finally(() => {
    if (openWorkspaceTasks.get(workspaceId) === task) openWorkspaceTasks.delete(workspaceId);
  });
  openWorkspaceTasks.set(workspaceId, task);
  return task;
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
