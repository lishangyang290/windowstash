import { browser } from 'wxt/browser';
import { applyLazyTabAppearance } from '@/features/workspaces/lazyTabAppearance';
import { lazyRestoreRepository } from '@/lib/storage/lazyRestoreRepository';

const recovery = document.getElementById('recovery')!;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

function showRecovery(unavailable: boolean, lazyId?: string) {
  if (unavailable && fallbackTimer) clearTimeout(fallbackTimer);
  const brand = document.createElement('strong');
  brand.textContent = 'WindowStash';
  const message = document.createElement('p');
  message.textContent = unavailable ? '无法恢复此标签页' : '无法自动恢复此标签页';
  const action = document.createElement('button');
  action.type = 'button';
  action.textContent = unavailable ? '关闭此标签页' : '重新加载原页面';
  action.onclick = unavailable
    ? () => void browser.runtime.sendMessage({ type: 'CLOSE_LAZY_TAB' }).catch(() => undefined)
    : () => void requestResolve(lazyId!);
  recovery.replaceChildren(brand, message, action);
}

async function requestResolve(lazyId: string) {
  const resolved = await browser.runtime.sendMessage({ type: 'RESOLVE_LAZY_TAB', lazyId }).catch(() => false);
  if (resolved === false) showRecovery(true);
}

async function notifyReady(lazyId: string) {
  const result = await browser.runtime.sendMessage({ type: 'LAZY_TAB_READY', lazyId }).catch(() => 'failed');
  if (result === 'missing') showRecovery(true);
}

function beginActiveRecovery(lazyId: string) {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  void notifyReady(lazyId);
  fallbackTimer = setTimeout(() => showRecovery(false, lazyId), 2000);
}

async function initialize() {
  const lazyId = new URLSearchParams(location.search).get('id');
  if (!lazyId) return showRecovery(true);
  const entry = await lazyRestoreRepository.get(lazyId);
  if (!entry) return showRecovery(true);
  const favicon = applyLazyTabAppearance(entry);
  const extensionPage = browser.runtime.getURL('/lazy-tab.html');
  const cachedFavicon = `${new URL('/_favicon/', extensionPage)}?pageUrl=${encodeURIComponent(entry.originalUrl)}&size=32`;
  favicon.onerror = () => {
    if (favicon.href !== cachedFavicon) favicon.href = cachedFavicon;
    else {
      favicon.onerror = null;
      favicon.href = new URL('/lazy-favicon.svg', extensionPage).toString();
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beginActiveRecovery(lazyId);
  });
  if (document.visibilityState === 'visible') beginActiveRecovery(lazyId);
  else await notifyReady(lazyId);
}

void initialize();
