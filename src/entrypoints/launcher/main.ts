import { browser } from 'wxt/browser';

const status = document.getElementById('status');
const workspaceId = new URLSearchParams(location.search).get('workspaceId');

document.body.style.cssText = 'margin:0;display:grid;min-height:100vh;place-items:center;background:#fff;color:#52525b;font:13px system-ui,sans-serif';

async function launch() {
  if (!workspaceId) throw new Error('Missing workspace');
  await browser.runtime.sendMessage({ type: 'OPEN_OR_FOCUS_WORKSPACE', workspaceId });
  const current = await browser.tabs.getCurrent();
  if (current?.id != null) await browser.tabs.remove(current.id);
}

void launch().catch(() => {
  if (status) status.textContent = '无法打开工作区';
});
