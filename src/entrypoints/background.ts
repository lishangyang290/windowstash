import { browser } from 'wxt/browser';
import { CLEANUP_ALARM, SYNC_ALARM } from '@/lib/constants';
import { syncEngine } from '@/lib/sync/syncEngine';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import type { BackgroundMessage } from '@/types/messages';
import { openOrFocusWorkspace } from '@/features/workspaces/workspaceService';

export default defineBackground(() => {
  const ensureAlarms = async () => {
    await browser.alarms.create(SYNC_ALARM, { periodInMinutes: 30 });
    await browser.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
  };

  browser.runtime.onInstalled.addListener(() => {
    void ensureAlarms();
    void syncEngine.syncAll();
  });
  browser.runtime.onStartup.addListener(() => {
    void ensureAlarms();
    void syncEngine.syncAll();
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) void syncEngine.syncAll();
    if (alarm.name === CLEANUP_ALARM) void syncEngine.cleanupExpiredLocalCopies();
  });
  browser.windows.onRemoved.addListener((windowId) => void bindingRepository.remove(windowId));
  browser.runtime.onMessage.addListener((rawMessage) => {
    const message = rawMessage as BackgroundMessage;
    if (message.type === 'OPEN_OR_FOCUS_WORKSPACE') return openOrFocusWorkspace(message.workspaceId);
    if (message.type === 'SYNC_ALL') void syncEngine.syncAll();
    if (message.type === 'SYNC_WORKSPACE') void syncEngine.syncWorkspace(message.workspaceId);
    if (message.type === 'CLEANUP_LOCAL') void syncEngine.cleanupExpiredLocalCopies();
  });

  void ensureAlarms();
});
