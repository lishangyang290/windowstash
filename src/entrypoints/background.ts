import { initializeDiagnostics } from '@/lib/storage/diagnostics';
import { clearQuickSaveSession, handleQuickSaveCommand, handleQuickSaveMessage } from '@/features/workspaces/quickSave';
import type { QuickSavePageMessage } from '@/features/workspaces/quickSaveProtocol';
import { requireDataAccount } from '@/lib/storage/accountScope';
import { accountStorageKey } from '@/lib/storage/accountScope';
import { isLibraryChange, libraryScope, publishNativeWorkspaces } from '@/lib/companion/workspaces';
import { authService } from '@/lib/supabase/authService';
import { pullNativeLibrary, watchNativeLibrary } from '@/lib/sync/nativeWatch';
import { captureDeletionWindow } from '@/features/workspaces/remoteDeletion';
import { browser } from 'wxt/browser';
import { CLEANUP_ALARM, LAZY_RECONCILIATION_ALARM, SYNC_ALARM, WINDOW_ASSOCIATION_ALARM } from '@/lib/constants';
import { syncEngine } from '@/lib/sync/syncEngine';
import { PENDING_SYNC_ALARM, schedulePendingSync, syncPendingWorkspaces } from '@/lib/sync/pendingSync';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import type { BackgroundMessage } from '@/types/messages';
import { LAZY_DATA_PREFIX } from '@/features/workspaces/lazyTabPage';
import { openOrFocusWorkspace, recoverWorkspace, reopenWorkspace, restoreSavedWorkspace } from '@/features/workspaces/workspaceService';
import {
  claimLazyTabFromBrowserTab,
  cleanupOrphanedLazyEntries,
  confirmLazyNavigation,
  finishStartupLazyReconciliation,
  handleLazyTabReady,
  handleDataLazyAction,
  hydrateStartupLazyTab,
  initializeStartupLazyReconciliation,
  isStartupLazyReconciliationActive,
  isStartupLazyReconciliationComplete,
  noteStartupLazyActivity,
  removeLazyTab,
  resolveLazyTab,
} from '@/features/workspaces/lazyRestore';
import {
  maintainWindowAssociations,
  refreshBoundWindowAssociation,
  restorePersistentWindowAssociations,
} from '@/features/workspaces/windowAssociation';

export default defineBackground(() => {
  initializeDiagnostics();
  browser.commands.onCommand.addListener((command, tab) => {
    void handleQuickSaveCommand(command, tab).catch(console.error);
  });
  const LOCAL_LIBRARY_ALARM = 'windowstash-local-library-retry';
  const synchronize = () => syncEngine.syncAll().catch(() => schedulePendingSync(5 * 60_000));
  const publishLocal = (scope: string, force = false) => publishNativeWorkspaces(scope, force)
    .then(() => pullNativeLibrary(scope))
    .catch(async () => { await pullNativeLibrary(scope).catch(() => undefined); await browser.alarms.create(LOCAL_LIBRARY_ALARM, { delayInMinutes: 1 }); });
  const publishCurrent = () => accountStorageKey('workspaces').then(async (scope) => { await watchNativeLibrary(scope); await publishLocal(scope, true); }).catch(() => undefined);
  browser.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (isLibraryChange(key, change.newValue)) void publishLocal(libraryScope(key));
    }
    if (changes['windowstash-companion:auth-link:v1'] || changes['windowstash-data-owner:v1']) void publishCurrent();
  });
  const ensureAlarms = async () => {
    await browser.alarms.create(SYNC_ALARM, { periodInMinutes: 30 });
    await browser.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
  };
  const scheduleAssociationMaintenance = (delay = 1_000) => browser.alarms.create(WINDOW_ASSOCIATION_ALARM, { when: Date.now() + delay });
  const persistWindowChange = (windowId: number) => {
    void accountStorageKey('workspaces').then(scope => captureDeletionWindow(scope, windowId)).catch(() => undefined);
    void refreshBoundWindowAssociation(windowId)
      .then((captured) => captured ? undefined : restorePersistentWindowAssociations())
      .catch(() => undefined);
    void scheduleAssociationMaintenance();
  };
  const startRecovery = () => initializeStartupLazyReconciliation().then(restorePersistentWindowAssociations).catch(console.error);

  browser.runtime.onInstalled.addListener(() => {
    void startRecovery();
    void ensureAlarms();
    void synchronize();
  });
  browser.runtime.onStartup.addListener(() => {
    void ensureAlarms();
    void synchronize();
    void startRecovery();
    void scheduleAssociationMaintenance(5_000);
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LOCAL_LIBRARY_ALARM) void publishCurrent();
    if (alarm.name === PENDING_SYNC_ALARM) void syncPendingWorkspaces().catch(() => undefined);
    if (alarm.name === SYNC_ALARM) void synchronize();
    if (alarm.name === CLEANUP_ALARM) {
      void syncEngine.cleanupExpiredLocalCopies();
      void Promise.all([isStartupLazyReconciliationActive(), isStartupLazyReconciliationComplete()]).then(([active, complete]) => {
        if (!active && complete) return cleanupOrphanedLazyEntries();
      });
    }
    if (alarm.name === LAZY_RECONCILIATION_ALARM) {
      void finishStartupLazyReconciliation()
        .then((complete) => complete ? maintainWindowAssociations() : undefined).catch(console.error);
    }
    if (alarm.name === WINDOW_ASSOCIATION_ALARM) void maintainWindowAssociations();
  });
  browser.windows.onRemoved.addListener((windowId) => {
    void bindingRepository.remove(windowId);
    void maintainWindowAssociations();
  });
  browser.tabs.onActivated.addListener(({ tabId }) => void resolveLazyTab(tabId).catch(() => undefined));
  browser.tabs.onCreated.addListener((tab) => {
    void noteStartupLazyActivity();
    void hydrateStartupLazyTab(tab).catch(() => undefined);
    persistWindowChange(tab.windowId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined) void handleDataLazyAction(tabId, changeInfo.url).catch(console.error);
    if (changeInfo.status === 'loading') void clearQuickSaveSession(tabId).catch(console.error);
    void noteStartupLazyActivity();
    void claimLazyTabFromBrowserTab(tab).then(async (claimed) => {
      if (claimed && tab.active && changeInfo.status === 'complete' && tab.url?.startsWith(LAZY_DATA_PREFIX)
        && (!tab.pendingUrl || tab.pendingUrl === tab.url)) await resolveLazyTab(tabId);
      if (!claimed && !await isStartupLazyReconciliationActive()) await confirmLazyNavigation(tabId, tab.url);
    }).catch(() => undefined);
    if (changeInfo.url !== undefined || changeInfo.pinned !== undefined) persistWindowChange(tab.windowId);
  });
  browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    void clearQuickSaveSession(tabId).catch(console.error);
    if (!removeInfo.isWindowClosing) {
      void removeLazyTab(tabId).catch(() => undefined);
    }
    if (!removeInfo.isWindowClosing) persistWindowChange(removeInfo.windowId);
  });
  browser.tabs.onMoved.addListener((_tabId, info) => { persistWindowChange(info.windowId); });
  browser.tabs.onAttached.addListener((_tabId, info) => { persistWindowChange(info.newWindowId); });
  browser.tabs.onDetached.addListener((tabId, info) => { void clearQuickSaveSession(tabId).catch(console.error); persistWindowChange(info.oldWindowId); });
  browser.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
    if (['QUICK_SAVE_PREVIEW', 'QUICK_SAVE_CONFIRM', 'QUICK_SAVE_OPEN', 'QUICK_SAVE_CLOSE'].includes(rawMessage?.type)) {
      void handleQuickSaveMessage(rawMessage as QuickSavePageMessage, sender).then(sendResponse, error => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    const message = rawMessage as BackgroundMessage;
    const managerAction = async <T>(task: () => Promise<T>) => {
      await authService.requireSession();
      if ('accountStorageKey' in message && message.accountStorageKey) await requireDataAccount(message.accountStorageKey);
      return task();
    };
    if (message.type === 'OPEN_OR_FOCUS_WORKSPACE') return managerAction(() => openOrFocusWorkspace(message.workspaceId));
    if (message.type === 'REOPEN_WORKSPACE') return managerAction(() => reopenWorkspace(message.workspaceId, message.sourceWindowId));
    if (message.type === 'RECOVER_WORKSPACE') return managerAction(() => recoverWorkspace(message.workspaceId, message.sourceWindowId));
    if (message.type === 'RESTORE_SAVED_WORKSPACE') return managerAction(() => restoreSavedWorkspace(message.workspaceId));
    if (message.type === 'LAZY_TAB_READY' && sender.tab?.id != null) {
      void noteStartupLazyActivity();
      return handleLazyTabReady(sender.tab.id, sender.tab.windowId, Boolean(sender.tab.active), message.lazyId);
    }
    if (message.type === 'RESOLVE_LAZY_TAB' && sender.tab?.id != null) {
      return resolveLazyTab(sender.tab.id, message.lazyId, sender.tab.windowId);
    }
    if (message.type === 'CLOSE_LAZY_TAB' && sender.tab?.id != null) return browser.tabs.remove(sender.tab.id);
    if (message.type === 'SYNC_ALL') return managerAction(() => syncEngine.syncAll(message.accountStorageKey));
    if (message.type === 'SYNC_WORKSPACE') return managerAction(() => syncEngine.syncWorkspace(message.workspaceId, message.accountStorageKey));
    if (message.type === 'CLEANUP_LOCAL') void syncEngine.cleanupExpiredLocalCopies();
  });

  void ensureAlarms();
  // session is cleared on reload/update as well as browser restart. Worker wakeups
  // within an existing session must not restart the reconciliation grace period.
  void startRecovery();
  void publishCurrent();
  void syncPendingWorkspaces().catch(() => undefined);
  void maintainWindowAssociations();
  void scheduleAssociationMaintenance();
});
