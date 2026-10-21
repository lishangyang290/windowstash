import type { QuickSaveMessage, QuickSavePreview, QuickSaveReply } from './quickSaveProtocol';
import { validateWorkspaceName } from './workspaceName';
import { showSuccessToast } from '@/components/showSuccessToast';
import { getTabDomain, getTabLocation, type TabChangeKind } from './tabDiff';
import styles from './quickSaveDialog.css?inline';

interface DialogState { focus: () => void }
const activeDialogs = globalThis as typeof globalThis & { __windowStashQuickSave?: DialogState };

export function showQuickSaveDialog(send: (message: QuickSaveMessage) => Promise<QuickSaveReply>) {
  if (activeDialogs.__windowStashQuickSave) { activeDialogs.__windowStashQuickSave.focus(); return true; }
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  host.style.setProperty('all', 'initial', 'important');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style'); style.textContent = styles;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'quick-save-title');
  // Only static markup; all page/workspace content is assigned with textContent.
  dialog.innerHTML = `<header class="summary-header"><div class="summary"><h2 id="quick-save-title" data-name>正在读取…</h2><label hidden><input aria-label="工作区名称" placeholder="输入工作区名称" autocomplete="off"></label><p data-count>正在读取当前窗口…</p></div><button type="button" data-close aria-label="关闭">×</button></header>
    <form><div class="change-cards" hidden><button type="button" class="change-card added" data-card="added"><strong data-added></strong><span>新增 <i aria-hidden="true">›</i></span></button><button type="button" class="change-card removed" data-card="removed"><strong data-removed></strong><span>移除 <i aria-hidden="true">›</i></span></button><button type="button" class="change-card" data-card="updated"><strong data-updated></strong><span>更新 <i aria-hidden="true">›</i></span></button></div>
    <section class="empty-state" role="status" hidden><span class="state-icon" aria-hidden="true">✓</span><div><strong data-state-title></strong><p data-state-description></p></div></section>
    <section class="details" hidden><div class="detail-heading"><button type="button" data-back>← 返回</button><h2 id="quick-save-details-title">本次保存的变更</h2><span aria-hidden="true"></span></div><nav class="change-tabs" aria-label="变更分类"></nav><div class="changes" data-changes tabindex="0" aria-label="标签页变化"></div></section>
    <p class="message" role="status" aria-live="polite"></p><button type="button" class="retry" hidden>重新读取</button>
    <footer><button type="button" data-cancel><span>取消</span><kbd>Esc</kbd></button><button type="submit" class="primary" disabled><span data-save-label>保存</span><kbd>Enter</kbd></button></footer></form>`;
  shadow.append(style, dialog); document.documentElement.append(host);
  const find = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const input = find<HTMLInputElement>('input'), save = find<HTMLButtonElement>('[type=submit]');
  const saveLabel = find('[data-save-label]');
  const message = find('.message'), retry = find<HTMLButtonElement>('.retry'), cards = find('.change-cards');
  const events = new AbortController();
  let preview: QuickSavePreview | undefined, busy = false, disposed = false, expanded = false, activeKind: TabChangeKind = 'added';
  const focus = () => (expanded ? find<HTMLButtonElement>('[data-back]') : preview && !preview.existing ? input : save.disabled ? find<HTMLButtonElement>('[data-close]') : save).focus({ preventScroll: true });
  activeDialogs.__windowStashQuickSave = { focus };
  const close = () => {
    if (busy || disposed) return;
    disposed = true; events.abort();
    dialog.close(); host.remove(); delete activeDialogs.__windowStashQuickSave;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    void send({ type: 'QUICK_SAVE_CLOSE' }).catch(() => undefined);
  };
  const updateEnabled = () => {
    save.disabled = busy || !preview || Boolean(!preview.existing && validateWorkspaceName(input.value, '').error);
    for (const kind of ['added', 'removed', 'updated'] as const) find<HTMLButtonElement>(`[data-card="${kind}"]`).disabled = busy || !preview?.counts[kind];
  };
  const renderChanges = () => {
    const list = find('[data-changes]'); list.replaceChildren();
    dialog.dataset.expanded = String(expanded);
    find('.summary-header').hidden = expanded;
    if (expanded) dialog.setAttribute('aria-labelledby', 'quick-save-details-title');
    else if (preview?.existing) dialog.setAttribute('aria-labelledby', 'quick-save-title');
    else dialog.removeAttribute('aria-labelledby');
    find('.details').hidden = !expanded;
    cards.hidden = expanded || !preview?.changes.length;
    find('.empty-state').hidden = expanded || !preview || Boolean(preview.changes.length);
    const tabs = find('.change-tabs'); tabs.replaceChildren();
    for (const kind of ['added', 'removed', 'updated'] as const) {
      const count = preview?.counts[kind] ?? 0;
      if (!count) continue;
      const tab = document.createElement('button'); tab.type = 'button'; tab.dataset.kind = kind;
      tab.textContent = `${{ added: '会加入', removed: '会移除', updated: '会更新' }[kind]} ${count}`;
      tab.setAttribute('aria-pressed', String(activeKind === kind)); tabs.append(tab);
    }
    for (const change of expanded ? preview?.changes.filter(change => change.kind === activeKind) ?? [] : []) {
      const row = document.createElement('div'); row.className = 'change';
      const favicon = document.createElement('span'); favicon.className = 'favicon'; favicon.setAttribute('aria-hidden', 'true');
      favicon.textContent = '◉';
      if (change.favIconUrl) {
        const image = document.createElement('img'); image.src = change.favIconUrl; image.alt = '';
        image.addEventListener('error', () => { image.remove(); favicon.textContent = '◉'; }, { once: true });
        favicon.replaceChildren(image);
      }
      const copy = document.createElement('div'); copy.className = 'change-copy';
      const title = document.createElement('strong'); title.textContent = change.title; title.title = `${change.title}\n${change.url}`; copy.append(title);
      if (change.kind === 'updated') {
        const urlChanged = change.previous.url !== change.url;
        if (urlChanged || change.previous.title !== change.title) {
          const detail = document.createElement('div'); detail.className = 'update-detail';
          for (const [label, value] of [['上次', urlChanged ? getTabLocation(change.previous.url) : change.previous.title], ['现在', urlChanged ? getTabLocation(change.url) : change.title]]) {
            const caption = document.createElement('i'); caption.textContent = label!;
            const text = document.createElement('b'); text.textContent = value!; text.title = value!; detail.append(caption, text);
          }
          copy.append(detail);
        }
        if (change.previous.pinned !== change.pinned) {
          const pin = document.createElement('span'); pin.className = 'pin-change';
          pin.textContent = `固定状态：${change.previous.pinned ? '已固定' : '未固定'} → ${change.pinned ? '已固定' : '未固定'}`; copy.append(pin);
        }
      } else {
        const location = document.createElement('span'); location.className = 'change-location'; location.textContent = getTabDomain(change.url); copy.append(location);
      }
      const open = document.createElement('button'); open.type = 'button'; open.className = 'item-action';
      open.dataset.changeIndex = String(preview!.changes.indexOf(change));
      open.textContent = change.kind === 'removed' ? '重新打开' : '查看';
      row.append(favicon, copy, open); list.append(row);
    }
  };
  const render = (next: QuickSavePreview) => {
    preview = next;
    find('[data-name]').textContent = next.name;
    find('[data-name]').hidden = !next.existing;
    if (next.existing) { dialog.setAttribute('aria-labelledby', 'quick-save-title'); dialog.removeAttribute('aria-label'); }
    else { dialog.removeAttribute('aria-labelledby'); dialog.setAttribute('aria-label', '新工作区'); }
    find('label').hidden = next.existing;
    find('[data-count]').textContent = `当前窗口 · ${next.tabCount} 个标签页`;
    for (const kind of ['added', 'removed', 'updated'] as const) {
      const counter = find(`[data-${kind}]`), count = next.counts[kind];
      counter.textContent = `${count ? { added: '+', removed: '−', updated: '' }[kind] : ''}${count}`;
      find(`[data-card="${kind}"]`).setAttribute('aria-label', `${{ added: '新增', removed: '移除', updated: '更新' }[kind]} ${count} 个标签页`);
    }
    dialog.dataset.unchanged = String(!next.changes.length && !next.reordered);
    find('.empty-state').classList.toggle('reordered', next.reordered);
    find('.state-icon').textContent = next.reordered ? '↕' : '✓';
    find('[data-state-title]').textContent = next.reordered ? '标签页顺序已变化' : '已是最新状态';
    find('[data-state-description]').textContent = next.reordered ? '保存后将更新标签页顺序' : '当前窗口与上次保存一致';
    if (!next.changes.length) expanded = false;
    if (!next.counts[activeKind]) activeKind = next.changes[0]?.kind ?? 'added';
    renderChanges();
    message.textContent = '';
    retry.hidden = true; updateEnabled();
  };
  const request = async (action: QuickSaveMessage) => {
    try {
      const reply = await send(action);
      if (disposed) return;
      if ('preview' in reply) render(reply.preview);
      if ('saved' in reply) {
        busy = false; close(); showSuccessToast('已保存');
        return true;
      }
      if ('error' in reply && reply.error) { message.textContent = reply.error; retry.hidden = false; }
    } catch (error) {
      if (!disposed) { message.textContent = error instanceof Error ? error.message : String(error); retry.hidden = false; }
    }
    return false;
  };
  const submit = async () => {
    if (busy || !preview) return;
    const validation = validateWorkspaceName(preview.existing ? preview.name : input.value, '');
    if (validation.error) { message.textContent = validation.error; input.focus({ preventScroll: true }); return; }
    busy = true; updateEnabled(); saveLabel.textContent = '保存中…';
    dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; }); input.disabled = true;
    const saved = await request({ type: 'QUICK_SAVE_CONFIRM', token: preview.token, name: validation.name });
    if (disposed || saved) return;
    busy = false; input.disabled = false; dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; });
    saveLabel.textContent = '保存'; updateEnabled();
  };
  const listen = { signal: events.signal };
  find('form').addEventListener('submit', event => { event.preventDefault(); void submit(); }, listen);
  input.addEventListener('input', updateEnabled, listen);
  cards.addEventListener('click', event => {
    const kind = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('[data-card]')?.dataset.card : undefined;
    if ((kind === 'added' || kind === 'removed' || kind === 'updated') && preview?.counts[kind] && !busy) {
      activeKind = kind; expanded = true; renderChanges(); find<HTMLButtonElement>('[data-back]').focus({ preventScroll: true });
    }
  }, listen);
  find('[data-back]').addEventListener('click', () => { expanded = false; renderChanges(); find<HTMLButtonElement>(`[data-card="${activeKind}"]`).focus({ preventScroll: true }); }, listen);
  find('.change-tabs').addEventListener('click', event => {
    const kind = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('button')?.dataset.kind : undefined;
    if (kind === 'added' || kind === 'removed' || kind === 'updated') { activeKind = kind; renderChanges(); find<HTMLButtonElement>(`[data-kind="${kind}"]`).focus({ preventScroll: true }); }
  }, listen);
  find('[data-changes]').addEventListener('click', event => {
    const button = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('[data-change-index]') : null;
    if (!button || !preview || busy) return;
    button.disabled = true;
    void request({ type: 'QUICK_SAVE_OPEN', token: preview.token, index: Number(button.dataset.changeIndex) }).finally(() => { button.disabled = false; });
  }, listen);
  retry.addEventListener('click', () => { retry.disabled = true; void request({ type: 'QUICK_SAVE_PREVIEW' }).then(() => { retry.disabled = false; focus(); }); }, listen);
  for (const selector of ['[data-close]', '[data-cancel]']) find(selector).addEventListener('click', close, listen);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }, listen);
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }, listen);
  window.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    else if (event.key === 'Enter' && !event.repeat) {
      const target = shadow.activeElement;
      if (target instanceof HTMLButtonElement && target !== save) return;
      event.preventDefault(); event.stopImmediatePropagation(); void submit();
    }
    else if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      const target = shadow.activeElement;
      if (target === input || (event.key === ' ' && target instanceof HTMLButtonElement)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const list = find('[data-changes]');
      if (target === list) {
        if (event.key === 'Home') list.scrollTop = 0;
        else if (event.key === 'End') list.scrollTop = list.scrollHeight;
        else list.scrollTop += (['ArrowUp', 'PageUp'].includes(event.key) ? -1 : 1) * (event.key.startsWith('Arrow') ? 28 : list.clientHeight);
      }
    }
  }, { ...listen, capture: true });
  dialog.addEventListener('wheel', event => { if (!(event.target instanceof Element) || !event.target.closest('.changes')) event.preventDefault(); }, { ...listen, passive: false });
  dialog.addEventListener('touchmove', event => { if (!(event.target instanceof Element) || !event.target.closest('.changes')) event.preventDefault(); }, { ...listen, passive: false });
  window.addEventListener('pagehide', () => { busy = false; close(); }, listen);
  try { dialog.showModal(); focus(); }
  catch (error) { close(); throw error; }
  void request({ type: 'QUICK_SAVE_PREVIEW' }).then(() => { if (!disposed) focus(); });
  return true;
}
