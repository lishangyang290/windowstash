import { browser, type Browser } from 'wxt/browser';
import { requireDataAccount } from '@/lib/storage/accountScope';
import { bindingRepository } from '@/lib/storage/bindingRepository';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { readDeletionNotice } from './remoteDeletion';
import { resolveLogicalTabs } from './lazyRestore';
import { focusWindowTab, reopenSavedTab, resolveWorkspaceStateForWindow, saveCurrentWindow } from './workspaceService';
import { calculateTabDiff } from './tabDiff';
import { scoreWorkspaceMatch } from './workspaceMatcher';
import { validateWorkspaceName } from './workspaceName';
import { QUICK_SAVE_COMMAND, QuickSavePreviewChangedError, windowSaveFingerprint, workspaceSaveFingerprint, type QuickSavePageMessage, type QuickSavePreview, type QuickSaveReply } from './quickSaveProtocol';
import { describeQuickSaveDisplayError, isOwnQuickSavePage, isRestrictedQuickSavePage, notifyQuickSaveFailure, QuickSaveDisplayError, recordQuickSaveDelivery, restrictedQuickSaveMessage, quickSaveErrorText as errorText } from './quickSaveDelivery';
export { isRestrictedQuickSavePage } from './quickSaveDelivery';

type PreviewState = Awaited<ReturnType<typeof prepare>>;
interface Session { windowId: number; documentId?: string; preview?: PreviewState; busy: boolean; pageToken?: string; pageUrl?: string }
const sessions = new Map<number, Session>();
const opening = new Set<number>();
const sessionKey = (tabId: number) => `windowstash-quick-save:${tabId}`;
async function getSession(tabId: number) {
  let saved = sessions.get(tabId);
  if (!saved) {
    const stored = (await browser.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)] as Session | undefined;
    saved = sessions.get(tabId) ?? stored;
  }
  if (saved) sessions.set(tabId, saved);
  return saved;
}
async function persistSession(tabId: number, session: Session) {
  if (sessions.get(tabId) === session) await browser.storage.session.set({ [sessionKey(tabId)]: { ...session, busy: false } });
}

async function prepare(windowId: number, expectedScope?: string) {
  const account = await requireDataAccount(expectedScope);
  const current = await browser.windows.get(windowId, { populate: true });
  if (current.id !== windowId || current.type !== 'normal') throw new Error('无法识别触发快捷键的 Chrome 普通窗口');
  const raw = current.tabs ?? [];
  if (!raw.length || raw.some(tab => !tab.url || tab.pendingUrl)) throw new Error('标签页仍在加载或地址无法读取，请稍后重试');
  const tabs = await resolveLogicalTabs([...raw].sort((a, b) => a.index - b.index), account.storageKey.replace(/^workspaces/, 'lazyRestoreEntries'));
  if (await readDeletionNotice(account.storageKey, windowId)) throw new Error('工作区已在其他设备删除，请先在 WindowStash 中确认删除通知');
  const resolution = await resolveWorkspaceStateForWindow(windowId, tabs, account.storageKey, true);
  if (resolution.status === 'unavailable' || resolution.status === 'unresolved') throw new Error('无法准确识别当前工作区，请在 WindowStash 中确认后重试');
  if (resolution.status === 'unbound' && !await bindingRepository.isSuppressed(windowId, account.storageKey)) {
    const records = await workspaceRepository.list(account.storageKey);
    if (records.some(record => scoreWorkspaceMatch(tabs, record).eligible)) throw new Error('存在相似或已绑定其他窗口的工作区，请先在 WindowStash 中确认');
  }
  const record = resolution.record;
  const diff = calculateTabDiff(record?.content.tabs ?? [], tabs);
  const preview: QuickSavePreview = {
    token: crypto.randomUUID(), name: record?.content.name ?? '', existing: Boolean(record), tabCount: tabs.length,
    counts: { added: diff.added.length, removed: diff.removed.length, updated: diff.updated.length },
    changes: [...diff.added, ...diff.removed, ...diff.updated],
    reordered: Boolean(record) && JSON.stringify(record!.content.tabs.map(tab => [tab.url, tab.pinned])) !== JSON.stringify(tabs.map(tab => [tab.url, Boolean(tab.pinned)])),
  };
  return { preview, scope: account.storageKey, status: record?.content.status ?? 'active' as const,
    expected: { fingerprint: windowSaveFingerprint(raw), workspaceId: resolution.workspaceId, content: await workspaceSaveFingerprint(record?.content ?? null) } };
}

export async function handleQuickSaveCommand(command: string, tab?: Browser.tabs.Tab) {
  if (command !== QUICK_SAVE_COMMAND) return;
  if (tab?.id == null || tab.windowId < 0) return notifyQuickSaveFailure('无法识别触发快捷键的标签页，请重新选择普通网页后重试。');
  const url = tab.pendingUrl || tab.url || '';
  if (isRestrictedQuickSavePage(url)) return notifyQuickSaveFailure(restrictedQuickSaveMessage, tab.id);
  if (opening.has(tab.id)) return;
  opening.add(tab.id);
  try {
    const session = await getSession(tab.id) ?? { windowId: tab.windowId, busy: false };
    sessions.set(tab.id, session);
    if (isOwnQuickSavePage(url)) {
      session.pageToken ??= crypto.randomUUID(); session.pageUrl = url;
      await persistSession(tab.id, session);
      const reply = await browser.runtime.sendMessage({ type: 'QUICK_SAVE_SHOW', tabId: tab.id, windowId: tab.windowId, token: session.pageToken }) as { shown?: boolean; error?: string; kind?: string } | undefined;
      if (!reply?.shown) throw new QuickSaveDisplayError(reply?.kind === 'execution' ? 'execution' : 'unavailable', reply?.error || 'WindowStash 管理页尚未就绪，请刷新页面后重试');
      await recordQuickSaveDelivery({ status: 'shown', tabId: tab.id, channel: 'extension-page', message: '管理页已确认弹窗显示' });
      return;
    }
    await persistSession(tab.id, session);
    const result = await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/quick-save.js'] });
    if (!result.some(frame => frame.frameId === 0 && frame.result === true)) throw new QuickSaveDisplayError('unsupported', '当前页面未确认快捷保存界面已显示，请重新加载网页后重试');
    await recordQuickSaveDelivery({ status: 'shown', tabId: tab.id, channel: 'injection', message: '页面已确认弹窗显示' });
  } catch (error) {
    try { await clearQuickSaveSession(tab.id); }
    catch (cleanupError) { console.error('WindowStash 快捷保存会话清理失败', cleanupError); }
    return notifyQuickSaveFailure(describeQuickSaveDisplayError(error), tab.id);
  } finally { opening.delete(tab.id); }
}

export async function clearQuickSaveSession(tabId: number) {
  sessions.delete(tabId); await browser.storage.session.remove(sessionKey(tabId));
}

export async function handleQuickSaveMessage(message: QuickSavePageMessage, sender: Browser.runtime.MessageSender): Promise<QuickSaveReply> {
  const context = message.pageContext;
  const ownPage = !sender.tab && sender.id === browser.runtime.id && isOwnQuickSavePage(sender.url ?? '') && (sender.frameId == null || sender.frameId === 0);
  const tabId = sender.tab?.id ?? (ownPage ? context?.tabId : undefined);
  const session = tabId == null ? undefined : await getSession(tabId);
  if (!session || (ownPage ? !context || session.pageToken !== context.token || session.windowId !== context.windowId || session.pageUrl !== sender.url
    : session.windowId !== sender.tab?.windowId || sender.frameId !== 0)
    || (session.documentId && session.documentId !== sender.documentId)) return { error: '快捷保存会话已失效，请关闭后重新按快捷键' };
  if (ownPage) {
    try {
      const current = await browser.tabs.get(tabId!);
      if (current.windowId !== session.windowId || current.url !== sender.url) return { error: '管理页已移动或导航，请重新按快捷键' };
    } catch { return { error: '管理页已关闭，请重新打开' }; }
  }
  if (message.type === 'QUICK_SAVE_CLOSE') { await clearQuickSaveSession(tabId!); return { error: '' }; }
  if (session.busy) return { error: '正在保存，请稍候' };
  session.documentId = sender.documentId;
  session.busy = true;
  try {
    if (message.type === 'QUICK_SAVE_PREVIEW') {
      session.preview = await prepare(session.windowId, session.preview?.scope);
      await persistSession(tabId!, session);
      return { preview: session.preview.preview };
    }
    const previous = session.preview;
    if (!previous || previous.preview.token !== message.token) throw new Error('预览已失效，请重新读取后保存');
    if (message.type === 'QUICK_SAVE_OPEN') {
      const change = Number.isInteger(message.index) ? previous.preview.changes[message.index] : undefined;
      if (!change) throw new Error('此项变化已失效，请重新读取');
      if (change.kind === 'removed') {
        await reopenSavedTab(session.windowId, change, previous.scope);
        session.preview = await prepare(session.windowId, previous.scope);
        await persistSession(tabId!, session);
        return { preview: session.preview.preview };
      }
      else if (change.tabId != null) {
        if ((await browser.tabs.get(change.tabId)).windowId !== session.windowId) throw new Error('标签页已移到其他窗口，请重新读取');
        await focusWindowTab(session.windowId, change.tabId, previous.scope);
      }
      else throw new Error('无法识别此标签页，请重新读取');
      return { opened: true };
    }
    const name = validateWorkspaceName(previous.preview.existing ? previous.preview.name : message.name, '');
    if (name.error) throw new Error(name.error);
    const next = await prepare(session.windowId, previous.scope);
    if (JSON.stringify(next.expected) !== JSON.stringify(previous.expected)) {
      session.preview = next;
      await persistSession(tabId!, session);
      return { preview: next.preview, error: '窗口或工作区已变化，预览已刷新，请再次确认保存' };
    }
    await saveCurrentWindow({ windowId: session.windowId, name: name.name, status: previous.status, closeAfterSave: false,
      accountStorageKey: previous.scope, expected: previous.expected });
    await clearQuickSaveSession(tabId!);
    return { saved: true };
  } catch (error) {
    if (error instanceof QuickSavePreviewChangedError && session.preview) {
      try {
        session.preview = await prepare(session.windowId, session.preview.scope);
        await persistSession(tabId!, session);
        return { preview: session.preview.preview, error: '窗口或工作区已变化，预览已刷新，请再次确认保存' };
      } catch (refreshError) { return { error: errorText(refreshError) }; }
    }
    return { error: errorText(error) };
  }
  finally { session.busy = false; }
}
