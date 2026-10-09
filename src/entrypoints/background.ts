import { browser } from 'wxt/browser';
import { CLEANUP_ALARM, LAZY_RECONCILIATION_ALARM, SYNC_ALARM, WINDOW_ASSOCIATION_ALARM } from '@/lib/constants';
import { syncEngine } from '@/lib/sync/syncEngine';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import type { BackgroundMessage } from '@/types/messages';
import { openOrFocusWorkspace, recoverWorkspace, reopenWorkspace, restoreSavedWorkspace } from '@/features/workspaces/workspaceService';
import {
  beginStartupLazyReconciliation,
  claimLazyTabFromBrowserTab,
  cleanupOrphanedLazyEntries,
  confirmLazyNavigation,
  finishStartupLazyReconciliation,
  handleLazyTabReady,
  hydrateStartupLazyTab,
  hydrateStartupLazyTabs,
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
  const ensureAlarms = async () => {
    await browser.alarms.create(SYNC_ALARM, { periodInMinutes: 30 });
    await browser.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
  };
  const scheduleAssociationMaintenance = (delay = 1_000) => browser.alarms.create(WINDOW_ASSOCIATION_ALARM, { when: Date.now() + delay });
  const persistWindowChange = (windowId: number) => {
    void refreshBoundWindowAssociation(windowId)
      .then((captured) => captured ? undefined : restorePersistentWindowAssociations())
      .catch(() => undefined);
    void scheduleAssociationMaintenance();
  };

  browser.runtime.onInstalled.addListener(() => {
    void ensureAlarms();
    void syncEngine.syncAll();
  });
  browser.runtime.onStartup.addListener(() => {
    void ensureAlarms();
    void syncEngine.syncAll();
    void beginStartupLazyReconciliation().then(hydrateStartupLazyTabs);
    void scheduleAssociationMaintenance(5_000);
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) void syncEngine.syncAll();
    if (alarm.name === CLEANUP_ALARM) {
      void syncEngine.cleanupExpiredLocalCopies();
      void Promise.all([isStartupLazyReconciliationActive(), isStartupLazyReconciliationComplete()]).then(([active, complete]) => {
        if (!active && complete) return cleanupOrphanedLazyEntries();
      });
    }
    if (alarm.name === LAZY_RECONCILIATION_ALARM) void finishStartupLazyReconciliation();
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
    void noteStartupLazyActivity();
    void claimLazyTabFromBrowserTab(tab).then(async (claimed) => {
      if (!claimed && !await isStartupLazyReconciliationActive()) await confirmLazyNavigation(tabId, tab.url);
    }).catch(() => undefined);
    if (changeInfo.url !== undefined || changeInfo.pinned !== undefined) persistWindowChange(tab.windowId);
  });
  browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (!removeInfo.isWindowClosing) {
      void isStartupLazyReconciliationActive().then((active) => {
        if (!active) return removeLazyTab(tabId);
      }).catch(() => undefined);
    }
    if (!removeInfo.isWindowClosing) persistWindowChange(removeInfo.windowId);
  });
  browser.tabs.onMoved.addListener((_tabId, info) => { persistWindowChange(info.windowId); });
  browser.tabs.onAttached.addListener((_tabId, info) => { persistWindowChange(info.newWindowId); });
  browser.tabs.onDetached.addListener((_tabId, info) => { persistWindowChange(info.oldWindowId); });
  browser.runtime.onMessage.addListener((rawMessage, sender) => {
    const message = rawMessage as BackgroundMessage;
    if (message.type === 'OPEN_OR_FOCUS_WORKSPACE') return openOrFocusWorkspace(message.workspaceId);
    if (message.type === 'REOPEN_WORKSPACE') return reopenWorkspace(message.workspaceId, message.sourceWindowId);
    if (message.type === 'RECOVER_WORKSPACE') return recoverWorkspace(message.workspaceId, message.sourceWindowId);
    if (message.type === 'RESTORE_SAVED_WORKSPACE') return restoreSavedWorkspace(message.workspaceId);
    if (message.type === 'LAZY_TAB_READY' && sender.tab?.id != null) {
      void noteStartupLazyActivity();
      return handleLazyTabReady(sender.tab.id, sender.tab.windowId, Boolean(sender.tab.active), message.lazyId);
    }
    if (message.type === 'RESOLVE_LAZY_TAB' && sender.tab?.id != null) {
      return resolveLazyTab(sender.tab.id, message.lazyId, sender.tab.windowId);
    }
    if (message.type === 'CLOSE_LAZY_TAB' && sender.tab?.id != null) return browser.tabs.remove(sender.tab.id);
    if (message.type === 'SYNC_ALL') void syncEngine.syncAll();
    if (message.type === 'SYNC_WORKSPACE') void syncEngine.syncWorkspace(message.workspaceId);
    if (message.type === 'CLEANUP_LOCAL') void syncEngine.cleanupExpiredLocalCopies();
  });

  void ensureAlarms();
  void maintainWindowAssociations();
  void scheduleAssociationMaintenance();
});
