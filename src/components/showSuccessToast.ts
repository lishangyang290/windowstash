import styles from '@/styles/successToast.css?inline';

const state = globalThis as typeof globalThis & { __windowStashDismissToast?: () => void };

// Use the existing toast's styles in an isolated host on ordinary webpages.
export function showSuccessToast(message: string) {
  state.__windowStashDismissToast?.();
  const host = document.createElement('div'); host.dataset.windowstashToast = '';
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style'); style.textContent = styles;
  const toast = document.createElement('div'); toast.className = 'success-toast'; toast.textContent = message;
  toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite');
  shadow.append(style, toast); document.documentElement.append(host);
  const dismiss = () => {
    window.clearTimeout(timer); window.removeEventListener('pagehide', dismiss); host.remove();
    if (state.__windowStashDismissToast === dismiss) delete state.__windowStashDismissToast;
  };
  const timer = window.setTimeout(dismiss, 2000);
  state.__windowStashDismissToast = dismiss;
  window.addEventListener('pagehide', dismiss, { once: true });
  return dismiss;
}
