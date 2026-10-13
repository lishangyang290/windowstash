import { accountStorageKey, requireDataAccount, withDataAccount } from '@/lib/storage/accountScope';
import { STORAGE_KEYS } from '@/lib/constants';
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
  resolveLogicalTabs,
  resolveLazyStoredTab,
} from './lazyRestore';
import { lazyRestoreRepository } from '@/lib/storage/lazyRestoreRepository';
import { windowAssociationRepository } from '@/lib/storage/windowAssociationRepository';
import {
  bindWindow,
  restorePersistentWindowAssociations,
} from './windowAssociation';

function requestSync(message: BackgroundMessage): void {
  void browser.runtime.sendMessage(message).catch(() => undefined);
}

async function recordLog(
  workspaceId: string,
  workspaceName: string,
  action: string,
  result: 'success' | 'failed',
  message: string,
  storageKey?: string,
) {
  await syncLogRepository.add({ workspaceId, workspaceName, action, result, message }, storageKey?.replace(/^workspaces/, STORAGE_KEYS.syncLogs));
}

export async function getCurrentWindowSnapshot() {
  const current = await browser.windows.getCurrent({ populate: true });
  if (current.id == null) throw new Error('无法识别当前 Chrome 窗口');
  const tabs = await resolveLogicalTabs([...(current.tabs ?? [])].sort((a, b) => a.index - b.index));
  return { windowId: current.id, tabs };
}

export type WorkspaceWindowResolution =
  | { status: 'resolved'; workspaceId: string; record: WorkspaceLocalRecord; source: 'binding' | 'matcher' }
  | { status: 'unavailable'; workspaceId: string; record: null; source: 'binding' }
  | { status: 'unresolved'; workspaceId: null; record: null; source: null }
  | { status: 'unbound'; workspaceId: null; record: null; source: null };

export async function resolveWorkspaceStateForWindow(
  windowId: number,
  tabs: MatchableTab[],
  requestedKey?: string,
  logicalTabsReady = false,
): Promise<WorkspaceWindowResolution> {
  const scope = requestedKey ?? await accountStorageKey('workspaces');
  const resolution = await resolveScopedWorkspaceState(windowId, tabs, scope, logicalTabsReady);
  if (scope !== await accountStorageKey('workspaces')) throw new Error('账号已变化，请重新打开');
  return resolution;
}

async function resolveScopedWorkspaceState(windowId: number, tabs: MatchableTab[], scope: string, logicalTabsReady: boolean): Promise<WorkspaceWindowResolution> {
  let boundId = await bindingRepository.get(windowId, scope);
  if (!boundId && !await bindingRepository.isSuppressed(windowId, scope)) {
    await restorePersistentWindowAssociations();
    boundId = await bindingRepository.get(windowId, scope);
  }
  if (boundId) {
    let bound = await workspaceRepository.get(boundId, scope);
    if (!bound) {
      if (await tombstoneRepository.has(boundId, scope.replace(/^workspaces/, STORAGE_KEYS.tombstones))) {
        await bindingRepository.suppress(windowId, scope);
        return { status: 'unbound', workspaceId: null, record: null, source: null };
      }
      await syncEngine.syncAll(scope).catch(() => undefined);
      bound = await workspaceRepository.get(boundId, scope);
      if (await tombstoneRepository.has(boundId, scope.replace(/^workspaces/, STORAGE_KEYS.tombstones))) {
        await bindingRepository.suppress(windowId, scope);
        return { status: 'unbound', workspaceId: null, record: null, source: null };
      }
    }
    return bound
      ? { status: 'resolved', workspaceId: boundId, record: bound, source: 'binding' }
      : { status: 'unavailable', workspaceId: boundId, record: null, source: 'binding' };
  }
  if (await bindingRepository.isSuppressed(windowId, scope)) {
    return { status: 'unbound', workspaceId: null, record: null, source: null };
  }

  let logicalTabs;
  try {
    logicalTabs = logicalTabsReady ? tabs : await resolveLogicalTabs(tabs);
  } catch {
    return { status: 'unresolved', workspaceId: null, record: null, source: null };
  }
  const matched = matchWorkspace(logicalTabs, await workspaceRepository.list(scope));
  const conflict = matched && await (async () => {
    const windows = await browser.windows.getAll({ populate: false });
    for (const window of windows) {
      if (window.id != null && window.id !== windowId && await bindingRepository.get(window.id, scope) === matched.content.id) return true;
    }
    return false;
  })();
  if (matched && !conflict) await bindWindow(windowId, matched.content.id, logicalTabs, scope);
  return matched && !conflict
    ? { status: 'resolved', workspaceId: matched.content.id, record: matched, source: 'matcher' }
    : { status: 'unbound', workspaceId: null, record: null, source: null };
}

export async function resolveWorkspaceForWindow(
  windowId: number,
  tabs: MatchableTab[],
): Promise<WorkspaceLocalRecord | null> {
  return (await resolveWorkspaceStateForWindow(windowId, tabs)).record;
}

export async function saveCurrentWindow(input: {
  windowId: number;
  name: string;
  status: WorkspaceStatus;
  closeAfterSave: boolean;
  accountStorageKey?: string;
}): Promise<WorkspaceContent> {
  const account = await requireDataAccount(input.accountStorageKey);
  const storageKey = account.storageKey;
  const current = await browser.windows.get(input.windowId, { populate: true });
  if (current.id !== input.windowId) throw new Error('当前窗口已不存在');
  const tabs = [...(current.tabs ?? [])].sort((a, b) => a.index - b.index);
  if (!tabs.length) throw new Error('当前窗口没有可保存的标签页');

  const boundId = await bindingRepository.get(input.windowId, storageKey);
  if (boundId && await tombstoneRepository.has(boundId, storageKey.replace(/^workspaces/, STORAGE_KEYS.tombstones))) {
    await bindingRepository.suppress(input.windowId, storageKey);
    throw new Error('工作区已删除，请重新打开弹窗后保存为新工作区');
  }
  let previous = boundId ? await workspaceRepository.get(boundId, storageKey) : null;
  if (boundId && !previous) {
    await syncEngine.syncAll(storageKey).catch(() => undefined);
    previous = await workspaceRepository.get(boundId, storageKey);
    if (!previous) throw new Error('暂时无法读取此工作区，请稍后重试');
  }
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

  await withDataAccount(account, async () => {
    await workspaceRepository.saveContent(content, storageKey);
    await bindWindow(input.windowId, content.id, tabs, storageKey);
    await recordLog(content.id, content.name, 'local-save', 'success', 'Local save success', storageKey);
    requestSync({ type: 'SYNC_WORKSPACE', workspaceId: content.id, accountStorageKey: storageKey });
    if (input.closeAfterSave) await browser.windows.remove(input.windowId);
  });
  return content;
}

interface RestoreWorkspaceOptions {
  focused?: boolean;
  cleanupOnFailure?: boolean;
  deferBinding?: boolean;
}

export async function restoreWorkspace(
  workspaceId: string,
  options: RestoreWorkspaceOptions = {},
): Promise<number> {
  const account = await requireDataAccount();
  const record = await workspaceRepository.get(workspaceId, account.storageKey);
  if (!record) throw new Error('本地工作区不存在，请先完成云端同步');
  const scope = record.accountStorageKey ?? account.storageKey;
  const requireScope = async () => { if (scope !== await accountStorageKey(STORAGE_KEYS.workspaces)) throw new Error('账号已变化，请重新打开工作区'); };
  await requireScope();
  const createdWindow = await browser.windows.create({ url: 'about:blank', focused: options.focused ?? true });
  if (!createdWindow || createdWindow.id == null) throw new Error('无法创建新的 Chrome 窗口');
  const initialTabId = createdWindow.tabs?.[0]?.id;
  const createdByPosition = new Map<number, number>();
  const lazyEntryIds: string[] = [];
  const tabs = [...record.content.tabs].sort((a, b) => a.position - b.position);
  const lazyKey = scope.replace(/^workspaces/, STORAGE_KEYS.lazyRestoreEntries);

  try {
    await requireScope();
    if (options.deferBinding) await bindingRepository.suppress(createdWindow.id, ...(scope === 'workspaces' ? [] : [scope]));
    else await bindingRepository.set(createdWindow.id, workspaceId, ...(scope === 'workspaces' ? [] : [scope]));

    await withDataAccount(account, async () => {
      for (const tab of tabs) {
        try {
          let created;
          if (canLazyRestore(tab, record.content.activeTabIndex)) {
            const entry = { ...createLazyEntry(workspaceId, tab), accountStorageKey: lazyKey };
            try {
              await lazyRestoreRepository.put(entry);
              lazyEntryIds.push(entry.id);
              created = await browser.tabs.create({ windowId: createdWindow.id, url: lazyTabUrl(entry.id), active: false, pinned: tab.pinned });
              await lazyRestoreRepository.put({ ...entry, tabId: created.id, windowId: createdWindow.id });
            } catch {
              await lazyRestoreRepository.remove(entry.id, lazyKey).catch(() => undefined);
              const index = lazyEntryIds.indexOf(entry.id);
              if (index >= 0) lazyEntryIds.splice(index, 1);
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
            scope,
          ).catch(() => undefined);
        }
      }
    });

    await requireScope();
    if (record.content.tabs.length > 0 && createdByPosition.size === 0) throw new Error('Workspace 标签页恢复失败');
    const activeTabId = createdByPosition.get(record.content.activeTabIndex) ?? [...createdByPosition.values()][0];
    if (activeTabId != null) await browser.tabs.update(activeTabId, { active: true });
    if (initialTabId != null && createdByPosition.size > 0) await browser.tabs.remove(initialTabId).catch(() => undefined);
    await workspaceRepository.put({
      ...record,
      sync: { ...record.sync, localExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
    });
    await recordLog(workspaceId, record.content.name, 'restore', 'success', 'Workspace restored', scope);
    return createdWindow.id;
  } catch (error) {
    await bindingRepository.remove(createdWindow.id, ...(scope === 'workspaces' ? [] : [scope])).catch(() => undefined);
    if (options.cleanupOnFailure) {
      await lazyRestoreRepository.removeMany(lazyEntryIds, ...(scope === 'workspaces' ? [] : [scope.replace(/^workspaces/, STORAGE_KEYS.lazyRestoreEntries)])).catch(() => undefined);
      await browser.windows.remove(createdWindow.id).catch(() => undefined);
    }
    throw error;
  }
}

const reopenWorkspaceTasks = new Map<string, Promise<number>>();

async function cleanupReopenedWindow(windowId: number, scope: string): Promise<void> {
  await bindingRepository.remove(windowId, ...(scope === 'workspaces' ? [] : [scope])).catch(() => undefined);
  await browser.windows.remove(windowId).catch(() => undefined);
}

async function restoreFromBoundWindow(
  workspaceId: string,
  sourceWindowId: number,
  closeSource: boolean,
  scope: string,
): Promise<number> {
  if (scope !== await accountStorageKey(STORAGE_KEYS.workspaces)) throw new Error('账号已变化，请重新打开工作区');
  if (await bindingRepository.get(sourceWindowId) !== workspaceId) throw new Error('当前窗口未绑定此工作区');
  let newWindowId: number;
  try {
    newWindowId = await restoreWorkspace(workspaceId, {
      focused: true,
      cleanupOnFailure: true,
      deferBinding: true,
    });
  } catch (error) {
    await browser.windows.update(sourceWindowId, { focused: true }).catch(() => undefined);
    throw error;
  }

  let transferStarted = false;
  try {
    if (scope !== await accountStorageKey(STORAGE_KEYS.workspaces)) throw new Error('账号已变化，请重新打开工作区');
    if (await bindingRepository.get(sourceWindowId) !== workspaceId) throw new Error('当前窗口绑定已变更');
    transferStarted = true;
    await bindingRepository.suppress(sourceWindowId, ...(scope === 'workspaces' ? [] : [scope]));
    await bindingRepository.set(newWindowId, workspaceId, ...(scope === 'workspaces' ? [] : [scope]));
  } catch (error) {
    if (transferStarted) await bindingRepository.set(sourceWindowId, workspaceId, ...(scope === 'workspaces' ? [] : [scope])).catch(() => undefined);
    await cleanupReopenedWindow(newWindowId, scope);
    await browser.windows.update(sourceWindowId, { focused: true }).catch(() => undefined);
    throw error;
  }

  if (closeSource) {
    try {
      await browser.windows.remove(sourceWindowId);
    } catch {
      await browser.windows.update(newWindowId, { focused: true }).catch(() => undefined);
    }
  }
  return newWindowId;
}

export async function reopenWorkspace(workspaceId: string, sourceWindowId: number): Promise<number> {
  await requireDataAccount();
  const scope = await accountStorageKey(STORAGE_KEYS.workspaces);
  const key = `${scope}:${sourceWindowId}:${workspaceId}`;
  const existing = reopenWorkspaceTasks.get(key);
  if (existing) return existing;
  const task = restoreFromBoundWindow(workspaceId, sourceWindowId, true, scope).finally(() => {
    if (reopenWorkspaceTasks.get(key) === task) reopenWorkspaceTasks.delete(key);
  });
  reopenWorkspaceTasks.set(key, task);
  return task;
}

const recoverWorkspaceTasks = new Map<string, Promise<number>>();

export async function recoverWorkspace(workspaceId: string, sourceWindowId: number): Promise<number> {
  await requireDataAccount();
  const scope = await accountStorageKey(STORAGE_KEYS.workspaces);
  const key = `${scope}:${sourceWindowId}:${workspaceId}`;
  const existing = recoverWorkspaceTasks.get(key);
  if (existing) return existing;
  const task = restoreFromBoundWindow(workspaceId, sourceWindowId, false, scope).finally(() => {
    if (recoverWorkspaceTasks.get(key) === task) recoverWorkspaceTasks.delete(key);
  });
  recoverWorkspaceTasks.set(key, task);
  return task;
}

export async function restoreSavedWorkspace(workspaceId: string): Promise<number> {
  await requireDataAccount();
  if (!await workspaceRepository.get(workspaceId)) await syncEngine.syncAll();
  return restoreWorkspace(workspaceId, { focused: true, cleanupOnFailure: true });
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
  }, record.accountStorageKey?.replace(/^workspaces/, STORAGE_KEYS.syncLogs));
}

async function runOpenOrFocusWorkspace(workspaceId: string, scope: string): Promise<number> {
  const requireScope = async () => { if (scope !== await accountStorageKey(STORAGE_KEYS.workspaces)) throw new Error('账号已变化，请重新打开工作区'); };
  let record = await workspaceRepository.get(workspaceId, scope);
  if (!record) {
    await syncEngine.syncAll(scope);
    record = await workspaceRepository.get(workspaceId, scope);
  }
  if (!record) throw new Error('工作区不存在或尚未同步');

  const windows = await browser.windows.getAll({ populate: true });
  await requireScope();
  const candidates: WindowCandidate[] = [];
  let unhealthyBoundWindowId: number | undefined;
  for (const window of windows) {
    if (window.id != null && await bindingRepository.get(window.id) === workspaceId) {
      try {
        await resolveLogicalTabs(window.tabs ?? []);
      } catch {
        unhealthyBoundWindowId = window.id;
        continue;
      }
      candidates.push({ windowId: window.id, beforeTabs: window.tabs?.length ?? 0, afterTabs: window.tabs?.length ?? 0, bindingMatched: true, score: null, eligible: true });
      await requireScope();
      await logLaunch(record, 'focus-existing', candidates).catch(() => undefined);
      await requireScope();
      await browser.windows.update(window.id, { focused: true });
      return window.id;
    }
  }
  for (const window of windows) {
    if (window.id == null || window.id === unhealthyBoundWindowId) continue;
    let resolvedTabs;
    try {
      resolvedTabs = await resolveLogicalTabs(window.tabs ?? []);
    } catch {
      candidates.push({ windowId: window.id, beforeTabs: window.tabs?.length ?? 0, afterTabs: 0, bindingMatched: false, score: null, eligible: false });
      continue;
    }
    const tabs = resolvedTabs.filter((tab) => !isInternalTab(tab));
    const match = scoreWorkspaceMatch(tabs, record);
    candidates.push({ windowId: window.id, beforeTabs: window.tabs?.length ?? 0, afterTabs: tabs.length, bindingMatched: false, score: match.score, eligible: match.eligible });
  }
  await requireScope();
  const ranked = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = ranked[0];
  const second = ranked[1];
  if (best?.eligible && second && (best.score ?? 0) - (second.score ?? 0) < MIN_CANDIDATE_GAP) {
    await logLaunch(record, 'ambiguous', candidates).catch(() => undefined);
    throw new Error('找到多个相似的 Workspace 窗口，已取消自动恢复');
  }
  if (best?.eligible) {
    await bindWindow(best.windowId, workspaceId, windows.find((window) => window.id === best.windowId)?.tabs, scope);
    await logLaunch(record, 'rebind-and-focus', candidates).catch(() => undefined);
    await requireScope();
    await browser.windows.update(best.windowId, { focused: true });
    return best.windowId;
  }
  await logLaunch(record, 'restore-new', candidates).catch(() => undefined);
  await requireScope();
  if (unhealthyBoundWindowId != null) return recoverWorkspace(workspaceId, unhealthyBoundWindowId);
  return restoreWorkspace(workspaceId);
}

export async function openOrFocusWorkspace(workspaceId: string): Promise<number> {
  await requireDataAccount();
  const scope = await accountStorageKey(STORAGE_KEYS.workspaces);
  const key = `${scope}:${workspaceId}`;
  const existing = openWorkspaceTasks.get(key);
  if (existing) return existing;
  const task = runOpenOrFocusWorkspace(workspaceId, scope).finally(() => {
    if (openWorkspaceTasks.get(key) === task) openWorkspaceTasks.delete(key);
  });
  openWorkspaceTasks.set(key, task);
  return task;
}

export async function openWorkspaceTab(url: string): Promise<void> {
  const account = await requireDataAccount();
  await withDataAccount(account, async () => { await browser.tabs.create({ url, active: true }); });
}

export async function focusWindowTab(windowId: number, tabId: number, expectedKey?: string): Promise<void> {
  const account = await requireDataAccount(expectedKey);
  await withDataAccount(account, async () => {
    await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(windowId, { focused: true });
  });
}

export async function reopenSavedTab(windowId: number, tab: StoredTab, expectedKey?: string): Promise<void> {
  const account = await requireDataAccount(expectedKey);
  await withDataAccount(account, async () => {
    await browser.tabs.create({ windowId, url: tab.url, active: true, index: tab.position, pinned: tab.pinned });
  });
}

export async function updateWorkspace(
  workspaceId: string,
  patch: Partial<Pick<WorkspaceContent, 'name' | 'status'>>,
  expectedKey?: string,
): Promise<void> {
  const account = await requireDataAccount(expectedKey);
  const record = await workspaceRepository.get(workspaceId, account.storageKey);
  if (!record) throw new Error('工作区不存在');
  await withDataAccount(account, async () => {
    await workspaceRepository.saveContent({ ...record.content, ...patch, updatedAt: new Date().toISOString() }, account.storageKey);
    requestSync({ type: 'SYNC_WORKSPACE', workspaceId, accountStorageKey: account.storageKey });
  });
}

export async function deleteWorkspace(workspaceId: string, expectedKey?: string): Promise<void> {
  const account = await requireDataAccount(expectedKey);
  const record = await workspaceRepository.get(workspaceId, account.storageKey);
  if (!record) return;
  await withDataAccount(account, async () => {
    await tombstoneRepository.add({ workspaceId, workspaceName: record.content.name,
      accountStorageKey: account.storageKey.replace(/^workspaces/, 'deleteTombstones'), deletedAt: new Date().toISOString() });
    await bindingRepository.suppressWorkspace(workspaceId, account.storageKey);
    await workspaceRepository.remove(workspaceId, account.storageKey);
    await windowAssociationRepository.removeForWorkspace(workspaceId, account.storageKey).catch(() => undefined);
    requestSync({ type: 'SYNC_ALL', accountStorageKey: account.storageKey });
  });
}
