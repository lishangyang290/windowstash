import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import type { WorkspaceLocalRecord } from '@/types/workspace';

const mocks = vi.hoisted(() => ({
  getWindow: vi.fn(), inject: vi.fn(), notify: vi.fn(), account: vi.fn(), resolve: vi.fn(), logical: vi.fn(),
  save: vi.fn(), suppressed: vi.fn(), list: vi.fn(), notice: vi.fn(),
  sessionGet: vi.fn(), sessionSet: vi.fn(), sessionRemove: vi.fn(), focus: vi.fn(), reopen: vi.fn(), getTab: vi.fn(),
  notificationPermission: vi.fn(), sendMessage: vi.fn(), badge: vi.fn(), badgeColor: vi.fn(), actionTitle: vi.fn(),
}));
vi.mock('wxt/browser', () => ({ browser: { windows: { get: mocks.getWindow }, scripting: { executeScript: mocks.inject },
  tabs: { get: mocks.getTab },
  storage: { session: { get: mocks.sessionGet, set: mocks.sessionSet, remove: mocks.sessionRemove } },
  notifications: { create: mocks.notify, getPermissionLevel: mocks.notificationPermission },
  action: { setBadgeText: mocks.badge, setBadgeBackgroundColor: mocks.badgeColor, setTitle: mocks.actionTitle },
  runtime: { id: 'test', sendMessage: mocks.sendMessage, getURL: (path: string) => `chrome-extension://test${path}` } } }));
vi.mock('@/lib/storage/accountScope', () => ({ requireDataAccount: mocks.account }));
vi.mock('@/lib/storage/bindingRepository', () => ({ bindingRepository: { isSuppressed: mocks.suppressed } }));
vi.mock('@/lib/storage/workspaceRepository', () => ({ workspaceRepository: { list: mocks.list } }));
vi.mock('../remoteDeletion', () => ({ readDeletionNotice: mocks.notice }));
vi.mock('../lazyRestore', () => ({ resolveLogicalTabs: mocks.logical }));
vi.mock('../workspaceService', () => ({ resolveWorkspaceStateForWindow: mocks.resolve, saveCurrentWindow: mocks.save, focusWindowTab: mocks.focus, reopenSavedTab: mocks.reopen }));
import { clearQuickSaveSession, handleQuickSaveCommand, handleQuickSaveMessage, isRestrictedQuickSavePage } from '../quickSave';
import { QuickSavePreviewChangedError, windowSaveFingerprint, type QuickSavePreview } from '../quickSaveProtocol';

const tab = { id: 3, windowId: 22, index: 0, active: true, title: 'A', url: 'https://a.example', pinned: true } as Browser.tabs.Tab;
const sender = { tab, frameId: 0, documentId: 'document-1' } as Browser.runtime.MessageSender;
const record = { content: { id: 'workspace-1', name: '工作', status: 'review', activeTabIndex: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01', tabs: [{ title: 'A', url: tab.url, pinned: true, position: 0 }] } } as WorkspaceLocalRecord;
async function open() {
  await handleQuickSaveCommand('quick-save-workspace', tab);
  const reply = await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW' }, sender);
  expect(reply).toHaveProperty('preview');
  return (reply as { preview: QuickSavePreview }).preview;
}
const confirm = (preview: QuickSavePreview, name = '新工作区') => handleQuickSaveMessage({ type: 'QUICK_SAVE_CONFIRM', token: preview.token, name }, sender);

beforeEach(async () => {
  vi.resetAllMocks(); mocks.sessionGet.mockResolvedValue({});
  await clearQuickSaveSession(3); await clearQuickSaveSession(9);
  mocks.inject.mockResolvedValue([{ frameId: 0, result: true }]);
  mocks.notificationPermission.mockResolvedValue('granted'); mocks.notify.mockResolvedValue('notification-1');
  mocks.account.mockResolvedValue({ storageKey: 'workspaces:user' });
  mocks.getWindow.mockResolvedValue({ id: 22, type: 'normal', tabs: [tab] });
  mocks.resolve.mockResolvedValue({ status: 'unbound', workspaceId: null, record: null });
  mocks.logical.mockImplementation(async tabs => tabs);
  mocks.list.mockResolvedValue([]); mocks.notice.mockResolvedValue(null);
});

describe('quick save', () => {
  it('views a changed tab through the existing service with an explicit window and account', async () => {
    const preview = await open(); mocks.getTab.mockResolvedValue(tab);
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_OPEN', token: preview.token, index: 0 }, sender)).toEqual({ opened: true });
    expect(mocks.focus).toHaveBeenCalledWith(22, 3, 'workspaces:user'); expect(mocks.save).not.toHaveBeenCalled();
    mocks.getTab.mockResolvedValue({ ...tab, windowId: 99 });
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_OPEN', token: preview.token, index: 0 }, sender)).toMatchObject({ error: expect.stringContaining('其他窗口') });
    expect(mocks.focus).toHaveBeenCalledTimes(1);
  });
  it('reopens a removed tab through the existing service and refreshes the preview', async () => {
    const removed = { title: 'Removed', url: 'https://removed.example', position: 1, pinned: true };
    mocks.resolve.mockResolvedValue({ status: 'resolved', workspaceId: 'workspace-1', record: { ...record, content: { ...record.content, tabs: [...record.content.tabs, removed] } } });
    const preview = await open(); const index = preview.changes.findIndex(change => change.kind === 'removed');
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_OPEN', token: preview.token, index }, sender)).toHaveProperty('preview');
    expect(mocks.reopen).toHaveBeenCalledWith(22, { ...removed, kind: 'removed' }, 'workspaces:user');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('previews and saves a first window through the same service as Popup, without closing', async () => {
    const preview = await open(); expect(preview).toMatchObject({ existing: false, name: '', tabCount: 1, counts: { added: 1, removed: 0, updated: 0 } });
    expect(await confirm(preview, '  新工作区  ')).toEqual({ saved: true });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ windowId: 22, name: '新工作区', status: 'active', closeAfterSave: false,
      accountStorageKey: 'workspaces:user', expected: { fingerprint: windowSaveFingerprint([tab]), workspaceId: null, content: 'null' } }));
    expect(mocks.getWindow.mock.calls.every(([id]) => id === 22)).toBe(true);
  });
  it.each(['', ' ', '字'.repeat(51)])('rejects invalid name %s', async name => {
    expect(await confirm(await open(), name)).toHaveProperty('error'); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([
    ['added', [tab, { ...tab, id: 4, index: 1, url: 'https://b.example' }], { added: 1, removed: 0, updated: 0 }],
    ['removed', [], { added: 0, removed: 1, updated: 0 }],
    ['updated', [{ ...tab, title: 'New title', pinned: false }], { added: 0, removed: 0, updated: 1 }],
    ['unchanged', [tab], { added: 0, removed: 0, updated: 0 }],
  ])('reuses tab Diff for %s', async (_label, tabs, counts) => {
    // Removal still leaves another unrelated tab in the Chrome window.
    const saved = tabs.length ? record : { content: { ...record.content, tabs: [...record.content.tabs, { title: 'B', url: 'https://b.example', pinned: false, position: 1 }] } };
    mocks.resolve.mockResolvedValue({ status: 'resolved', workspaceId: 'workspace-1', record: saved });
    mocks.getWindow.mockResolvedValue({ id: 22, type: 'normal', tabs: tabs.length ? tabs : [tab] });
    const preview = await open(); expect(preview.counts).toEqual(counts); expect(preview.name).toBe('工作');
    await confirm(preview, 'ignored'); expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ name: '工作', status: 'review' }));
  });
  it('retains duplicate URLs, order and pinned flags in the exact guard', async () => {
    const tabs = [tab, { ...tab, id: 4, index: 1, pinned: false }];
    mocks.getWindow.mockResolvedValue({ id: 22, type: 'normal', tabs });
    const preview = await open(); expect(preview.tabCount).toBe(2); await confirm(preview);
    expect(mocks.save.mock.calls[0]?.[0].expected.fingerprint).toBe(windowSaveFingerprint(tabs));
    expect(windowSaveFingerprint(tabs)).not.toBe(windowSaveFingerprint([...tabs].reverse().map((item, index) => ({ ...item, index }))));
  });
  it('refreshes changed tabs and requires a second confirmation', async () => {
    const preview = await open(); mocks.getWindow.mockResolvedValue({ id: 22, type: 'normal', tabs: [tab, { ...tab, id: 4, index: 1 }] });
    const reply = await confirm(preview); expect(reply).toMatchObject({ error: expect.stringContaining('再次确认'), preview: { tabCount: 2 } });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(await confirm((reply as { preview: QuickSavePreview }).preview)).toEqual({ saved: true });
  });
  it('requires confirmation again if the workspace binding changes', async () => {
    const preview = await open(); mocks.resolve.mockResolvedValue({ status: 'resolved', workspaceId: 'workspace-1', record });
    expect(await confirm(preview)).toHaveProperty('preview'); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('allows retry after a save failure', async () => {
    const preview = await open(); mocks.save.mockRejectedValueOnce(new Error('磁盘写入失败'));
    expect(await confirm(preview)).toEqual({ error: '磁盘写入失败' }); expect(await confirm(preview)).toEqual({ saved: true });
  });
  it('refreshes the preview automatically if the final save guard detects a race', async () => {
    const preview = await open(); mocks.save.mockRejectedValueOnce(new QuickSavePreviewChangedError('工作区已变化，请重新确认预览'));
    const reply = await confirm(preview);
    expect(reply).toMatchObject({ preview: { existing: false }, error: expect.stringContaining('预览已刷新') });
    const refreshed = (reply as { preview: QuickSavePreview }).preview;
    expect(refreshed.token).not.toBe(preview.token);
    expect(await confirm(refreshed)).toEqual({ saved: true });
  });
  it('does not flag field order or timestamp changes as new workspace content', async () => {
    mocks.resolve.mockResolvedValue({ status: 'resolved', workspaceId: 'workspace-1', record });
    const preview = await open();
    mocks.resolve.mockResolvedValue({ status: 'resolved', workspaceId: 'workspace-1', record: { ...record,
      content: { ...Object.fromEntries(Object.entries(record.content).reverse()), updatedAt: '2026-10-21' } } });
    expect(await confirm(preview)).toEqual({ saved: true }); expect(mocks.save).toHaveBeenCalledOnce();
  });
  it('restores the preview after a background worker restart', async () => {
    const preview = await open();
    const stored = mocks.sessionSet.mock.calls.at(-1)![0];
    await clearQuickSaveSession(3); mocks.sessionGet.mockResolvedValue(stored);
    expect(await confirm(preview)).toEqual({ saved: true });
    expect(mocks.sessionRemove).toHaveBeenCalledWith('windowstash-quick-save:3');
  });
  it('rejects concurrent submissions', async () => {
    const preview = await open(); let finish!: () => void;
    mocks.save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = confirm(preview);
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(await confirm(preview)).toEqual({ error: '正在保存，请稍候' }); finish(); await pending;
  });
  it('cancels without saving and invalidates the token', async () => {
    const preview = await open(); await handleQuickSaveMessage({ type: 'QUICK_SAVE_CLOSE' }, sender);
    expect(await confirm(preview)).toHaveProperty('error'); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('blocks stale documents, child frames and other windows', async () => {
    const preview = await open();
    for (const invalid of [{ ...sender, documentId: 'other' }, { ...sender, frameId: 2 }, { ...sender, tab: { ...tab, windowId: 23 } }]) {
      expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_CONFIRM', token: preview.token, name: 'A' }, invalid)).toHaveProperty('error');
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps simultaneous window sessions separate', async () => {
    const first = await open(); const secondTab = { ...tab, id: 9, windowId: 42 };
    await handleQuickSaveCommand('quick-save-workspace', secondTab);
    mocks.getWindow.mockResolvedValue({ id: 42, type: 'normal', tabs: [secondTab] });
    const secondSender = { ...sender, tab: secondTab };
    const reply = await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW' }, secondSender);
    expect(reply).toHaveProperty('preview');
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_CONFIRM', token: first.token, name: 'A' }, secondSender)).toHaveProperty('error');
    const second = (reply as { preview: QuickSavePreview }).preview;
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_CONFIRM', token: second.token, name: 'B' }, secondSender)).toEqual({ saved: true });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ windowId: 42 }));
  });
  it.each(['chrome://settings', 'chrome://extensions', 'chrome://newtab', 'https://chromewebstore.google.com/detail/a', 'https://chrome.google.com/webstore/detail/a', 'chrome-extension://other/a', 'devtools://devtools'])('notifies without injecting or saving on %s', async url => {
    expect(isRestrictedQuickSavePage(url)).toBe(true); await handleQuickSaveCommand('quick-save-workspace', { ...tab, url });
    expect(mocks.inject).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'WindowStash', requireInteraction: false,
      message: '当前页面受 Chrome 安全限制，无法显示快捷保存弹窗。请切换到普通网页后重试。' }));
  });
  it('reports injection errors accurately on ordinary pages', async () => {
    mocks.inject.mockRejectedValueOnce(new Error('页面已关闭'));
    await handleQuickSaveCommand('quick-save-workspace', tab);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ message: '页面暂不可用：页面已关闭' }));
  });
  it.each(['about:blank', 'blob:https://a.example/id', 'data:text/html,test', 'unknown://page', 'unreadable-url'])('uses the actual scripting capability for uncertain URL %s', async url => {
    expect(isRestrictedQuickSavePage(url)).toBe(false);
    await handleQuickSaveCommand('quick-save-workspace', { ...tab, url });
    expect(mocks.inject).toHaveBeenCalledOnce(); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('uses internal messaging on our own management page and binds replies to that page/window', async () => {
    const url = 'chrome-extension://test/options.html', ownTab = { ...tab, url };
    expect(isRestrictedQuickSavePage(url)).toBe(false); mocks.sendMessage.mockResolvedValue({ shown: true }); mocks.getTab.mockResolvedValue(ownTab);
    await handleQuickSaveCommand('quick-save-workspace', ownTab);
    expect(mocks.inject).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled();
    const { token } = mocks.sendMessage.mock.calls[0]![0]; const pageContext = { tabId: tab.id!, windowId: tab.windowId, token };
    const ownSender = { id: 'test', url, frameId: 0, documentId: 'own-document' };
    const reply = await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW', pageContext }, ownSender);
    expect(reply).toHaveProperty('preview');
    for (const invalid of [{ ...ownSender, id: 'other' }, { ...ownSender, url: 'chrome-extension://other/options.html' }, { ...ownSender, frameId: 2 }]) {
      expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW', pageContext }, invalid)).toHaveProperty('error');
    }
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW', pageContext: { ...pageContext, token: 'wrong' } }, ownSender)).toHaveProperty('error');
    const preview = (reply as { preview: QuickSavePreview }).preview;
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_CONFIRM', token: preview.token, name: '管理页测试', pageContext }, ownSender)).toEqual({ saved: true });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ windowId: 22, closeAfterSave: false }));
  });
  it('reports our page bridge not being ready without attempting scripting or silently saving', async () => {
    mocks.sendMessage.mockResolvedValue(undefined);
    await handleQuickSaveCommand('quick-save-workspace', { ...tab, url: 'chrome-extension://test/options.html' });
    expect(mocks.inject).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('管理页尚未就绪') }));
  });
  it('preserves execution errors reported by the management page', async () => {
    mocks.sendMessage.mockResolvedValue({ error: 'showModal failed', kind: 'execution' });
    await handleQuickSaveCommand('quick-save-workspace', { ...tab, url: 'chrome-extension://test/options.html' });
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ message: '页面执行异常：showModal failed' }));
  });
  it.each([
    ['Cannot access contents of url. Missing host permission.', '页面访问权限受限'],
    ['No tab with id: 3', '页面暂不可用'],
    ['Unexpected token in quick-save.js', '页面执行异常'],
  ])('classifies actual injection error %s', async (reason, category) => {
    mocks.inject.mockRejectedValueOnce(new Error(reason));
    await handleQuickSaveCommand('quick-save-workspace', tab);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ message: `${category}：${reason}` }));
  });
  it('reports a missing UI acknowledgement as unsupported, not a protected Chrome page', async () => {
    mocks.inject.mockResolvedValue([{ frameId: 0, result: undefined }]);
    await handleQuickSaveCommand('quick-save-workspace', tab);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('页面不支持悬浮界面') }));
  });
  it('records notification permission and the actual returned notification id', async () => {
    expect(await handleQuickSaveCommand('quick-save-workspace', { ...tab, url: 'chrome://newtab' })).toMatchObject({ status: 'notification-created', permission: 'granted', notificationId: 'notification-1' });
    expect(mocks.notificationPermission).toHaveBeenCalledOnce();
    expect(mocks.sessionSet).toHaveBeenCalledWith(expect.objectContaining({ 'windowstash-quick-save:last-delivery': expect.objectContaining({ status: 'notification-created', notificationId: 'notification-1' }) }));
  });
  it.each(['denied', 'permission-error', 'create-error', 'empty-id'])('makes notification failure observable for %s', async failure => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      if (failure === 'denied') mocks.notificationPermission.mockResolvedValue('denied');
      if (failure === 'permission-error') mocks.notificationPermission.mockRejectedValue(new Error('权限查询失败'));
      if (failure === 'create-error') mocks.notify.mockRejectedValue(new Error('通知创建失败'));
      if (failure === 'empty-id') mocks.notify.mockResolvedValue('');
      expect(await handleQuickSaveCommand('quick-save-workspace', { ...tab, url: 'chrome://settings' })).toMatchObject({ status: 'notification-failed', error: expect.any(String) });
      if (failure === 'denied' || failure === 'permission-error') expect(mocks.notify).not.toHaveBeenCalled();
      expect(mocks.badge).toHaveBeenCalledWith({ tabId: 3, text: '!' });
      expect(mocks.actionTitle).toHaveBeenCalledWith(expect.objectContaining({ tabId: 3, title: expect.stringContaining('系统通知未发送') }));
      expect(mocks.sessionSet).toHaveBeenCalledWith(expect.objectContaining({ 'windowstash-quick-save:last-delivery': expect.objectContaining({ status: 'notification-failed' }) }));
      expect(errorLog).toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });
  it('does not guess a window if Chrome omitted the command tab', async () => {
    await handleQuickSaveCommand('quick-save-workspace'); expect(mocks.inject).not.toHaveBeenCalled(); expect(mocks.notify).toHaveBeenCalled();
  });
  it('coalesces shortcuts while injection is in flight', async () => {
    let finish!: (result: object[]) => void;
    mocks.inject.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = handleQuickSaveCommand('quick-save-workspace', tab);
    await vi.waitFor(() => expect(mocks.inject).toHaveBeenCalledTimes(1));
    await handleQuickSaveCommand('quick-save-workspace', tab); expect(mocks.inject).toHaveBeenCalledTimes(1);
    finish([{ frameId: 0, result: true }]); await first;
  });
  it.each(['unavailable', 'unresolved'])('rejects %s workspace state', async status => {
    mocks.resolve.mockResolvedValue({ status, workspaceId: 'missing', record: null });
    await handleQuickSaveCommand('quick-save-workspace', tab);
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW' }, sender)).toHaveProperty('error'); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('blocks ambiguous or other-window matches using the existing matcher score', async () => {
    mocks.list.mockResolvedValue([record]); await handleQuickSaveCommand('quick-save-workspace', tab);
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW' }, sender)).toMatchObject({ error: expect.stringContaining('相似') });
  });
  it('blocks unreadable/loading tabs, remote deletions and signed-out accounts', async () => {
    await handleQuickSaveCommand('quick-save-workspace', tab);
    mocks.getWindow.mockResolvedValueOnce({ id: 22, type: 'normal', tabs: [{ ...tab, pendingUrl: 'https://new.example' }] });
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW' }, sender)).toMatchObject({ error: expect.stringContaining('加载') });
    mocks.notice.mockResolvedValueOnce({ id: 'deleted' });
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW' }, sender)).toMatchObject({ error: expect.stringContaining('删除') });
    mocks.account.mockRejectedValueOnce(new Error('请先登录 WindowStash'));
    expect(await handleQuickSaveMessage({ type: 'QUICK_SAVE_PREVIEW' }, sender)).toEqual({ error: '请先登录 WindowStash' });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
