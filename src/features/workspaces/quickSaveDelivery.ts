import { browser } from 'wxt/browser';

export const QUICK_SAVE_DELIVERY_KEY = 'windowstash-quick-save:last-delivery';
export const restrictedQuickSaveMessage = '当前页面受 Chrome 安全限制，无法显示快捷保存弹窗。请切换到普通网页后重试。';
export const quickSaveErrorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function isOwnQuickSavePage(url: string) {
  try {
    const page = new URL(url), own = new URL(browser.runtime.getURL('/'));
    return page.protocol === own.protocol && page.host === own.host;
  } catch { return false; }
}

export function isRestrictedQuickSavePage(url: string) {
  try {
    const page = new URL(url);
    return ['chrome:', 'chrome-search:', 'chrome-untrusted:', 'devtools:'].includes(page.protocol)
      || (page.protocol === 'chrome-extension:' && !isOwnQuickSavePage(url))
      || (['http:', 'https:'].includes(page.protocol) && (page.hostname === 'chromewebstore.google.com'
        || (page.hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/.test(page.pathname))));
  } catch { return false; } // Unknown URLs use Chrome's actual permission/execution checks.
}

export class QuickSaveDisplayError extends Error {
  constructor(public kind: 'unsupported' | 'unavailable' | 'execution', message: string) { super(message); }
}

export function describeQuickSaveDisplayError(error: unknown) {
  const reason = quickSaveErrorText(error);
  const category = error instanceof QuickSaveDisplayError
    ? error.kind === 'unsupported' ? '页面不支持悬浮界面' : error.kind === 'unavailable' ? '页面暂不可用' : '页面执行异常'
    : /cannot access|missing host permission|permission|not allowed|cannot be scripted/i.test(reason) ? '页面访问权限受限'
    : /no tab with id|no frame with id|frame.*removed|no document|receiving end does not exist|message port closed|页面已关闭|标签页已关闭/i.test(reason) ? '页面暂不可用'
    : '页面执行异常';
  return `${category}：${reason}`;
}

interface DeliveryReport {
  status: 'shown' | 'notification-created' | 'notification-failed';
  tabId?: number;
  message: string;
  channel?: 'injection' | 'extension-page';
  permission?: string;
  notificationId?: string;
  error?: string;
}

export async function recordQuickSaveDelivery(report: DeliveryReport) {
  const tabKey = `${QUICK_SAVE_DELIVERY_KEY}:${report.tabId}`;
  try {
    const previous = (await browser.storage.session.get(tabKey))[tabKey] as DeliveryReport | undefined;
    if (report.status !== 'notification-failed' && previous?.status === 'notification-failed' && report.tabId != null) {
      await browser.action.setBadgeText({ tabId: report.tabId, text: '' });
      await browser.action.setTitle({ tabId: report.tabId, title: 'WindowStash' });
    }
    const entry = { ...report, at: new Date().toISOString() };
    await browser.storage.session.set({ [QUICK_SAVE_DELIVERY_KEY]: entry, [tabKey]: entry });
  } catch (error) { console.error('WindowStash 快捷保存反馈记录失败', error); }
}

export async function notifyQuickSaveFailure(message: string, tabId?: number) {
  let permission: string | undefined;
  try {
    if (!browser.notifications?.getPermissionLevel) throw new Error('Notifications API 不可用，请重新加载扩展并确认 notifications 权限');
    permission = await browser.notifications.getPermissionLevel();
    if (permission !== 'granted') throw new Error('Chrome 通知权限已被关闭，请允许 Google Chrome / WindowStash 通知');
    const notificationId = await browser.notifications.create({ type: 'basic', iconUrl: browser.runtime.getURL('/icon-128.png'), title: 'WindowStash', message, requireInteraction: false });
    if (!notificationId) throw new Error('Chrome 未返回通知标识，无法确认通知已创建');
    const report = { status: 'notification-created' as const, tabId, message, permission, notificationId };
    await recordQuickSaveDelivery(report);
    return report;
  } catch (error) {
    const reason = quickSaveErrorText(error);
    const report = { status: 'notification-failed' as const, tabId, message, permission, error: reason };
    console.error('WindowStash 系统通知未发送', report);
    const target = tabId == null ? {} : { tabId };
    const results = await Promise.allSettled([
      browser.action.setBadgeText({ ...target, text: '!' }),
      browser.action.setBadgeBackgroundColor({ ...target, color: '#F59E0B' }),
      browser.action.setTitle({ ...target, title: `WindowStash\n${message}\n系统通知未发送：${reason}` }),
    ]);
    for (const result of results) if (result.status === 'rejected') console.error('WindowStash 通知失败标记未能显示', result.reason);
    await recordQuickSaveDelivery(report);
    return report;
  }
}
