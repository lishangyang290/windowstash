/* global document, location, history, setTimeout, clearTimeout, URLSearchParams */
(() => {
  const favicon = document.getElementById('lazy-tab-favicon');
  const savedFavicon = favicon?.getAttribute('data-saved-favicon');
  if (savedFavicon && savedFavicon !== favicon.getAttribute('href')) {
    // Keep the embedded fallback visible while the saved icon loads. Probing an
    // image works even when the browser does not emit load/error on link icons.
    const image = document.createElement('img');
    image.referrerPolicy = 'no-referrer';
    image.onload = () => { favicon.href = savedFavicon; };
    image.src = savedFavicon;
  }
  const recovery = document.getElementById('recovery');
  const template = document.getElementById('lazy-recovery-template');
  let timer;
  let attempt = 0;
  let request;
  function showRecovery(message) {
    recovery.replaceChildren(template.content.cloneNode(true));
    if (message) recovery.querySelector('[data-status]').textContent = message;
    recovery.querySelector('button').onclick = () => requestResolve(true);
  }
  function sendAction(action) {
    const marker = new URLSearchParams(location.hash.slice(1));
    request = `${Date.now()}-${++attempt}`;
    marker.set('windowstash-action', action);
    marker.set('windowstash-request', request);
    marker.delete('windowstash-result');
    // Chrome blocks location.hash navigation on top-level data pages.
    history.replaceState(null, '', `#${marker}`);
  }
  function requestResolve(manual = false) {
    clearTimeout(timer);
    timer = setTimeout(() => showRecovery(manual ? '恢复请求尚未完成，请重试或点击上方链接。' : undefined), 2000);
    if (manual) showRecovery();
    try { sendAction('restore'); }
    catch { clearTimeout(timer); showRecovery('恢复请求失败，请重试或点击上方链接。'); }
  }
  document.defaultView.addEventListener('hashchange', () => {
    const marker = new URLSearchParams(location.hash.slice(1));
    if (marker.get('windowstash-action') !== 'result' || marker.get('windowstash-request') !== request) return;
    clearTimeout(timer);
    if (marker.get('windowstash-result') === 'missing') {
      recovery.replaceChildren(document.getElementById('lazy-missing-template').content.cloneNode(true));
      recovery.querySelector('button').onclick = () => sendAction('close');
    } else showRecovery('恢复失败，请重试或点击上方链接。');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestResolve();
    else clearTimeout(timer);
  });
  if (document.visibilityState === 'visible') requestResolve();
})();
