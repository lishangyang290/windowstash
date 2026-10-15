import { browser, type Browser } from 'wxt/browser';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { windowAssociationRepository } from '@/lib/storage/windowAssociationRepository';
import { requireDataAccount, withDataAccount } from '@/lib/storage/accountScope';

export interface DeletionNotice { id: string; workspaceId: string; deletedAt: string; windowId: number; tabs: { url: string; pinned: boolean }[] }
export const deletionNoticeKey = (scope: string) => scope.replace(/^workspaces/, 'workspaceDeletionNotices');
const windowKey = (scope: string, id: number) => scope.replace(/^workspaces/, `windowDeletion:${id}`);
function tabsOf(window: Browser.windows.Window) { return (window.tabs ?? []).map(tab => ({ url: tab.pendingUrl || tab.url || 'about:blank', pinned: Boolean(tab.pinned) })); }
async function notices(scope: string): Promise<Record<string, DeletionNotice>> {
  return (await browser.storage.local.get(deletionNoticeKey(scope)))[deletionNoticeKey(scope)] as Record<string, DeletionNotice> ?? {};
}
export async function readDeletionNotice(scope: string, windowId: number): Promise<DeletionNotice | null> {
  const id = (await browser.storage.session.get(windowKey(scope, windowId)))[windowKey(scope, windowId)] as string | undefined;
  return id ? (await notices(scope))[id] ?? null : null;
}
export async function acknowledgeDeletion(scope: string, windowId: number) {
  const account = await requireDataAccount(scope);
  return withDataAccount(account, async () => {
  const notice = await readDeletionNotice(scope, windowId); if (!notice) return;
  const items = await notices(scope); delete items[notice.id];
  await browser.storage.local.set({ [deletionNoticeKey(scope)]: items });
  await browser.storage.session.remove(windowKey(scope, windowId));
  await bindingRepository.suppress(windowId, scope);
  const window = await browser.windows.get(windowId, { populate: true });
  const tab = window.tabs?.find(item => item.active);
  if (tab?.id != null) {
    await browser.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => undefined);
    await browser.action.setTitle({ tabId: tab.id, title: 'WindowStash' }).catch(() => undefined);
  }
  });
}
export async function captureDeletionWindow(scope: string, windowId: number) {
  const account = await requireDataAccount(scope);
  return withDataAccount(account, async () => {
  const notice = await readDeletionNotice(scope, windowId); if (!notice) return;
  const window = await browser.windows.get(windowId, { populate: true });
  const items = await notices(scope); items[notice.id] = { ...notice, tabs: tabsOf(window) };
  await browser.storage.local.set({ [deletionNoticeKey(scope)]: items });
  });
}
export async function restoreDeletionNotices(scope: string) {
  const items = await notices(scope), windows = await browser.windows.getAll({ populate: true });
  for (const notice of Object.values(items)) {
    const candidates = windows.filter(window => JSON.stringify(tabsOf(window)) === JSON.stringify(notice.tabs));
    const candidate = candidates[0];
    if (candidates.length !== 1 || candidate?.id == null) continue;
    const windowId = candidate.id;
    if (await bindingRepository.get(windowId, scope)) continue;
    await browser.storage.session.set({ [windowKey(scope, windowId)]: notice.id });
    await bindingRepository.suppress(windowId, scope);
  }
}

async function weakHint(window: Browser.windows.Window) {
  const tab = window.tabs?.find(item => item.active); if (tab?.id == null) return;
  try {
    const url = new URL(tab.url ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || !await browser.permissions.contains({ origins: [`${url.origin}/*`] })) throw new Error('No injection permission');
    await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;pointer-events:none';
      const shadow = host.attachShadow({ mode: 'closed' }), box = document.createElement('div');
      box.style.cssText = 'padding:16px 20px;background:#212224;color:#fff;border-radius:10px;font:14px/1.6 system-ui;box-shadow:0 4px 20px #0003';
      const title = document.createElement('strong'); title.textContent = '工作区已在其他设备删除';
      const text = document.createElement('div'); text.textContent = '当前窗口及标签页不会受到影响。';
      box.append(title, text); shadow.append(box); document.documentElement.append(host); setTimeout(() => host.remove(), 5_000);
    } });
  } catch {
    // The icon belongs to this tab/window; no permission escalation or global notification.
    await browser.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#FBBF24' }).catch(() => undefined);
    await browser.action.setBadgeTextColor({ tabId: tab.id, color: '#212224' }).catch(() => undefined);
    await browser.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => undefined);
    await browser.action.setTitle({ tabId: tab.id, title: '工作区已在其他设备删除\n当前窗口及标签页不会受到影响。' }).catch(() => undefined);
    setTimeout(() => { void browser.action.setBadgeText({ tabId: tab.id!, text: '' }).catch(() => undefined); }, 5_000);
  }
}
export async function notifyRemoteDeletion(scope: string, workspaceId: string, deletedAt: string) {
  const items = await notices(scope), windows = await browser.windows.getAll({ populate: true });
  for (const window of windows) {
    if (window.id == null || await bindingRepository.get(window.id, scope) !== workspaceId) continue;
    const id = `${workspaceId}:${deletedAt}:${window.id}`;
    if (!items[id]) {
      items[id] = { id, workspaceId, deletedAt, windowId: window.id, tabs: tabsOf(window) };
      await browser.storage.local.set({ [deletionNoticeKey(scope)]: items });
      await browser.storage.session.set({ [windowKey(scope, window.id)]: id });
      // Persist notice and unbind before attempting a visual hint.
      await bindingRepository.suppress(window.id, scope);
      void weakHint(window);
    } else await bindingRepository.suppress(window.id, scope);
  }
  await windowAssociationRepository.removeForWorkspace(workspaceId, scope);
}
