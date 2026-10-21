import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showQuickSaveDialog } from '../quickSaveDialog';
import { showSuccessToast } from '@/components/showSuccessToast';
import type { QuickSaveMessage, QuickSavePreview, QuickSaveReply } from '../quickSaveProtocol';

const preview: QuickSavePreview = { token: 'preview-1', name: '', existing: false, tabCount: 3, reordered: false,
  counts: { added: 3, removed: 0, updated: 0 }, changes: [0, 1, 2].map(index => ({ kind: 'added', title: `<页面 ${index}>`, url: `https://example.com/${index}`, position: index, pinned: false })) };
let document: Document, window: Window;
let send: ReturnType<typeof vi.fn<(message: QuickSaveMessage) => Promise<QuickSaveReply>>>;
const root = () => document.documentElement.lastElementChild!.shadowRoot!;
const key = (value: string, extra = {}) => {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key: value, repeat: false, isComposing: false, ...extra }); window.dispatchEvent(event);
};
async function open() { showQuickSaveDialog(send); await vi.waitFor(() => expect(root().querySelector('[data-count]')?.textContent).toContain('3 个标签页')); }

beforeEach(() => {
  const dom = parseHTML('<html><body><p>原网页</p></body></html>');
  document = dom.document as unknown as Document; window = dom.window as unknown as Window;
  Object.assign(globalThis, { document, window, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, Element: dom.window.Element, Event: dom.window.Event });
  const attachShadow = dom.window.Element.prototype.attachShadow;
  vi.spyOn(dom.window.Element.prototype, 'attachShadow').mockImplementation(function (this: Element) { return attachShadow.call(this, { mode: 'open' }); });
  Object.assign(dom.window.HTMLElement.prototype, { showModal() {}, close() {} });
  send = vi.fn(async message => message.type === 'QUICK_SAVE_PREVIEW' ? { preview } : message.type === 'QUICK_SAVE_CONFIRM' ? { saved: true } : { error: '' });
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  // DOM-only tests stub native modal behavior; Chrome focus/layout remains a manual check.
  const state = globalThis as typeof globalThis & { __windowStashQuickSave?: unknown };
  delete state.__windowStashQuickSave; vi.restoreAllMocks(); vi.useRealTimers();
});

describe('quick save dialog event wiring', () => {
  it('puts the keyboard hints inside the two action buttons', async () => {
    await open();
    expect(root().querySelector('[data-cancel] kbd')?.textContent).toBe('Esc');
    expect(root().querySelector('[type=submit] kbd')?.textContent).toBe('Enter');
    expect(root().querySelector('footer')?.textContent).not.toContain('Esc 取消 · Enter 保存');
  });
  it.each([true, false])('shows the same before/after details as Popup (URL changed: %s)', async urlChanged => {
    send.mockResolvedValueOnce({ preview: { ...preview, existing: true, name: '已有工作区', changes: [{ kind: 'updated', title: '现在的标题', url: urlChanged ? 'https://example.com/new' : 'https://example.com/old', position: 0, pinned: true,
      previous: { title: '上次的标题', url: 'https://example.com/old', position: 0, pinned: false } }], counts: { added: 0, removed: 0, updated: 1 } } });
    await open(); root().querySelector<HTMLButtonElement>('[data-card="updated"]')!.click(); const detail = root().querySelector('.update-detail')!;
    expect([...detail.querySelectorAll('i')].map(label => label.textContent)).toEqual(['上次', '现在']);
    expect([...detail.querySelectorAll('b')].map(value => value.textContent)).toEqual(urlChanged ? ['example.com/old', 'example.com/new'] : ['上次的标题', '现在的标题']);
    expect(root().querySelector('.pin-change')?.textContent).toBe('固定状态：未固定 → 已固定');
  });
  it('uses three category cards and supports returning from details', async () => {
    await open(); const shadow = root(); expect(shadow.querySelectorAll('.change')).toHaveLength(0);
    expect(shadow.querySelectorAll('[data-card]')).toHaveLength(3);
    expect(shadow.querySelector('.view-changes')).toBeNull();
    expect(shadow.querySelector<HTMLButtonElement>('[data-card="removed"]')!.disabled).toBe(true);
    expect(shadow.querySelector('.expand')).toBeNull();
    expect(shadow.querySelector('dialog')!.textContent).not.toContain('查看全部变化');
    shadow.querySelector<HTMLButtonElement>('[data-card="added"]')!.click(); expect(shadow.querySelectorAll('.change')).toHaveLength(3);
    expect(shadow.querySelector('.change')?.textContent).toContain('<页面 0>'); expect(shadow.querySelector('.change')?.children).toHaveLength(3);
    shadow.querySelector<HTMLButtonElement>('[data-back]')!.click(); expect(shadow.querySelectorAll('.change')).toHaveLength(0);
    expect(shadow.querySelector<HTMLElement>('.change-cards')!.hidden).toBe(false);
    showQuickSaveDialog(send); expect(document.documentElement.children).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('uses the Popup detail header, favicon and view action', async () => {
    await open(); const shadow = root(); shadow.querySelector<HTMLButtonElement>('[data-card="added"]')!.click();
    expect(shadow.querySelector<HTMLElement>('.summary-header')!.hidden).toBe(true);
    expect(shadow.querySelector('.detail-heading h2')?.textContent).toBe('本次保存的变更');
    expect(shadow.querySelector('.change-tabs button')?.textContent).toBe('会加入 3');
    expect(shadow.querySelector('.favicon')).toBeTruthy();
    expect(shadow.querySelector('.change-location')?.textContent).toBe('example.com');
    shadow.querySelector<HTMLButtonElement>('.item-action')!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'QUICK_SAVE_OPEN', token: 'preview-1', index: 0 }));
    expect(shadow.querySelector('dialog')?.getAttribute('aria-labelledby')).toBe('quick-save-details-title');
    shadow.querySelector<HTMLButtonElement>('[data-back]')!.click();
    expect(shadow.querySelector<HTMLElement>('.summary-header')!.hidden).toBe(false);
    expect(shadow.querySelector('dialog')?.getAttribute('data-expanded')).toBe('false');
  });
  it('promotes the workspace name and shows symbolic counts with category details', async () => {
    const added = preview.changes[0]!;
    send.mockResolvedValueOnce({ preview: { ...preview, existing: true, name: 'firefly官网', counts: { added: 1, removed: 1, updated: 1 },
      changes: [added, { kind: 'removed', title: '移除的页面', url: 'https://example.com/removed', position: 1, pinned: false },
        { ...added, kind: 'updated', title: '更新的页面', previous: { title: '旧标题', url: added.url, position: 0, pinned: false } }] } });
    await open(); const shadow = root();
    expect(shadow.querySelector('header h2')?.textContent).toBe('firefly官网');
    expect(shadow.querySelector('dialog')!.textContent).not.toContain('保存工作区');
    expect(shadow.querySelector('[data-added]')?.textContent).toBe('+1');
    expect(shadow.querySelector('[data-removed]')?.textContent).toBe('−1');
    expect(shadow.querySelector('[data-updated]')?.textContent).toBe('1');
    expect(shadow.querySelector('[data-card="updated"]')?.getAttribute('aria-label')).toBe('更新 1 个标签页');
    for (const [kind, title] of [['added', '<页面 0>'], ['removed', '移除的页面'], ['updated', '更新的页面']]) {
      shadow.querySelector<HTMLButtonElement>(`[data-card="${kind}"]`)!.click();
      expect(shadow.querySelectorAll('.change')).toHaveLength(1);
      expect(shadow.querySelector('.change-copy strong')?.textContent).toBe(title);
      expect(shadow.querySelector(`[data-kind="${kind}"]`)?.getAttribute('aria-pressed')).toBe('true');
      shadow.querySelector<HTMLButtonElement>('[data-back]')!.click();
    }
    expect(send.mock.calls.filter(([message]) => message.type === 'QUICK_SAVE_CONFIRM')).toHaveLength(0);
  });
  it('Esc cancels without saving and permits opening again', async () => {
    await open(); key('Escape'); expect(document.documentElement.children).toHaveLength(1);
    expect(send.mock.calls.map(([message]) => message.type)).toEqual(['QUICK_SAVE_PREVIEW', 'QUICK_SAVE_CLOSE']);
    await open(); expect(root().querySelector('dialog')).toBeTruthy();
  });
  it('requires a valid name and ignores Enter during IME composition', async () => {
    await open(); key('Enter'); expect(root().querySelector('.message')?.textContent).toBe('请输入工作区名称');
    root().querySelector<HTMLInputElement>('input')!.value = '工作区'; key('Enter', { isComposing: true });
    expect(send.mock.calls.filter(([message]) => message.type === 'QUICK_SAVE_CONFIRM')).toHaveLength(0);
  });
  it('Enter saves, blocks repeat submission and Esc while saving, then closes', async () => {
    await open(); let finish!: (reply: QuickSaveReply) => void;
    send.mockImplementation(message => message.type === 'QUICK_SAVE_CONFIRM' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ error: '' }));
    root().querySelector<HTMLInputElement>('input')!.value = ' 工作区 '; key('Enter'); key('Enter'); key('Escape');
    expect(send.mock.calls.filter(([message]) => message.type === 'QUICK_SAVE_CONFIRM')).toEqual([[{ type: 'QUICK_SAVE_CONFIRM', token: 'preview-1', name: '工作区' }]]);
    expect(root().querySelector('dialog')).toBeTruthy(); vi.useFakeTimers(); finish({ saved: true });
    await Promise.resolve(); await Promise.resolve();
    expect(root().querySelector('dialog')).toBeNull();
    expect(root().querySelector('.success-toast')?.textContent).toBe('已保存');
    expect(root().querySelector('.success-toast')?.getAttribute('role')).toBe('status');
    await vi.advanceTimersByTimeAsync(2000); expect(document.documentElement.children).toHaveLength(1);
  });
  it('keeps the dialog and supports click-save retry after failure', async () => {
    await open(); root().querySelector<HTMLInputElement>('input')!.value = '工作区';
    send.mockResolvedValueOnce({ error: '写入失败' }); key('Enter');
    await vi.waitFor(() => expect(root().querySelector('.message')?.textContent).toBe('写入失败'));
    expect(document.querySelector('[data-windowstash-toast]')).toBeNull();
    expect(root().querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(false);
    expect(root().querySelector('[type=submit] kbd')?.textContent).toBe('Enter');
    // Native button -> submit dispatch is provided by Chrome; exercise the same form listener here.
    root().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(root().querySelector('.success-toast')?.textContent).toBe('已保存'));
  });
  it('cleans up the previous success toast and allows another dialog immediately', async () => {
    vi.useFakeTimers(); showSuccessToast('已保存');
    await vi.advanceTimersByTimeAsync(500); showSuccessToast('已保存');
    expect(document.querySelectorAll('[data-windowstash-toast]')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.querySelectorAll('[data-windowstash-toast]')).toHaveLength(1);
    await open(); expect(root().querySelector('dialog')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelectorAll('[data-windowstash-toast]')).toHaveLength(0);
    expect(root().querySelector('dialog')).toBeTruthy();
  });
  it('renders an existing workspace without requesting its name again', async () => {
    send.mockResolvedValueOnce({ preview: { ...preview, existing: true, name: '已有工作区', changes: [], counts: { added: 0, removed: 0, updated: 0 } } });
    await open(); expect(root().querySelector('label')!.hidden).toBe(true);
    expect(root().querySelector('[data-state-title]')?.textContent).toBe('已是最新状态');
    expect(root().querySelector('[data-state-description]')?.textContent).toBe('当前窗口与上次保存一致');
    expect(root().querySelector<HTMLElement>('.empty-state')!.hidden).toBe(false);
    expect(root().querySelector<HTMLElement>('.change-cards')!.hidden).toBe(true);
    expect(root().querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
    root().querySelector<HTMLButtonElement>('[data-cancel]')!.click(); expect(document.documentElement.children).toHaveLength(1);
  });
  it('does not label an order-only change as unchanged', async () => {
    send.mockResolvedValueOnce({ preview: { ...preview, existing: true, name: '已有工作区', reordered: true, changes: [], counts: { added: 0, removed: 0, updated: 0 } } });
    await open();
    expect(root().querySelector('[data-state-title]')?.textContent).toBe('标签页顺序已变化');
    expect(root().querySelector('[data-state-description]')?.textContent).toBe('保存后将更新标签页顺序');
    expect(root().querySelector('dialog')?.getAttribute('data-unchanged')).toBe('false');
  });
});
