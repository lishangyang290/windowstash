import { browser } from 'wxt/browser';
import { showQuickSaveDialog } from './quickSaveDialog';
import type { QuickSaveShowMessage } from './quickSaveProtocol';

// Extension pages render their own UI; scripting injection is unnecessary here.
export async function registerQuickSavePage() {
  const page = await browser.tabs.getCurrent();
  if (page?.id == null) return;
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (raw, sender, sendResponse) => {
    const message = raw as QuickSaveShowMessage;
    if (message?.type !== 'QUICK_SAVE_SHOW' || sender.id !== browser.runtime.id || message.tabId !== page.id) return;
    void browser.tabs.getCurrent().then(current => {
      if (current?.id !== message.tabId || current.windowId !== message.windowId) { sendResponse({ error: '管理页已移动，请重新按快捷键', kind: 'unavailable' }); return; }
      const shown = showQuickSaveDialog(request => browser.runtime.sendMessage({ ...request, pageContext: {
        tabId: message.tabId, windowId: message.windowId, token: message.token,
      } }));
      sendResponse({ shown });
    }).catch(error => sendResponse({ error: error instanceof Error ? error.message : String(error), kind: 'execution' }));
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  window.addEventListener('pagehide', () => browser.runtime.onMessage.removeListener(listener), { once: true });
}
