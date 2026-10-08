import { browser } from 'wxt/browser';
import { applyLazyTabAppearance } from '@/features/workspaces/lazyTabAppearance';
import { lazyRestoreRepository } from '@/lib/storage/lazyRestoreRepository';
import { renderLazyRecovery } from './recovery';

const recovery = document.getElementById('recovery')!;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

function showRecovery(unavailable: boolean, lazyId?: string, originalUrl?: string) {
  if (unavailable && fallbackTimer) clearTimeout(fallbackTimer);
  renderLazyRecovery(recovery, {
    unavailable,
    originalUrl,
    onClose: () => void browser.runtime.sendMessage({ type: 'CLOSE_LAZY_TAB' }).catch(() => undefined),
    onRetry: () => void requestResolve(lazyId!, originalUrl),
  });
}

async function requestResolve(lazyId: string, originalUrl?: string) {
  const resolved = await browser.runtime.sendMessage({ type: 'RESOLVE_LAZY_TAB', lazyId }).catch(() => false);
  if (resolved === false) showRecovery(false, lazyId, originalUrl);
}

async function notifyReady(lazyId: string) {
  const result = await browser.runtime.sendMessage({ type: 'LAZY_TAB_READY', lazyId }).catch(() => 'failed');
  if (result === 'missing') showRecovery(true);
}

function beginActiveRecovery(lazyId: string, originalUrl: string) {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  void notifyReady(lazyId);
  fallbackTimer = setTimeout(() => showRecovery(false, lazyId, originalUrl), 2000);
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
    if (document.visibilityState === 'visible') beginActiveRecovery(lazyId, entry.originalUrl);
  });
  if (document.visibilityState === 'visible') beginActiveRecovery(lazyId, entry.originalUrl);
  else await notifyReady(lazyId);
}

void initialize();
