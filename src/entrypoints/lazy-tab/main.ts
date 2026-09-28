import { browser } from 'wxt/browser';
import { lazyRestoreRepository } from '@/lib/storage/lazyRestoreRepository';

document.body.style.cssText = 'margin:0;background:#fff';

async function initialize() {
  const lazyId = new URLSearchParams(location.search).get('id');
  if (!lazyId) return;
  const entry = await lazyRestoreRepository.get(lazyId);
  if (!entry) return;
  document.title = entry.title;

  const icon = new Image();
  icon.onload = () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = entry.favIconUrl;
    document.head.append(link);
  };
  icon.onerror = () => void browser.runtime.sendMessage({ type: 'RESOLVE_LAZY_TAB', lazyId });
  icon.referrerPolicy = 'no-referrer';
  icon.src = entry.favIconUrl;
}

void initialize();
