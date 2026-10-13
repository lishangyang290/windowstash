import { accountOwner } from '@/lib/storage/accountScope';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { browser, type Browser } from 'wxt/browser';
import { Logo } from '@/components/Logo';
import { SuccessToast } from '@/components/SuccessToast';
import {
  calculateTabDiff,
  getTabDomain,
  getTabLocation,
  type CurrentTabSnapshot,
  type TabChange,
  type TabChangeKind,
  type UpdatedTabChange,
} from '@/features/workspaces/tabDiff';
import {
  focusWindowTab,
  reopenSavedTab,
  saveCurrentWindow,
  updateWorkspace,
  type WorkspaceWindowResolution,
} from '@/features/workspaces/workspaceService';
import { LazyTabResolutionError } from '@/features/workspaces/lazyRestore';
import { validateWorkspaceName } from '@/features/workspaces/workspaceName';
import type { WorkspaceLocalRecord, WorkspaceStatus } from '@/types/workspace';
import { useVerifiedAccess } from '@/lib/supabase/useVerifiedAccess';
import { WorkspaceActions } from './WorkspaceActions';
import { loadPopupWindow, readPopupWindow, type PopupSnapshot } from './startup';
import { startPopupPerformance, markPopupCommit, popupPerformanceSnapshot } from '@/lib/popupPerformance';
import '@/styles/base.css';
import './style.css';

type SaveAction = 'save' | 'close';
type SavePhase = 'idle' | 'saving';

const CHANGE_LABELS: Record<TabChangeKind, string> = {
  added: '会加入',
  removed: '会移除',
  updated: '会更新',
};

const CHANGE_DESCRIPTIONS: Record<TabChangeKind, string> = {
  added: '这些标签页现在在当前窗口中，但上次没有保存。',
  removed: '这些标签页存在于上次保存中，但当前窗口里已经没有了。',
  updated: '这些标签页仍然存在，但保存内容发生了变化。',
};

function PopupPreparing({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <main className="popup-shell popup-main-shell" data-popup-state="preparing" aria-busy={!error}>
    <header className="popup-header"><Logo /></header>
    <section className="popup-content">
      <div className="bound-summary popup-placeholder-summary" aria-hidden="true">
        <span className="popup-skeleton popup-skeleton-title" />
        <span className="popup-skeleton popup-skeleton-subtitle" />
      </div>
      <div className="unchanged-state" role={error ? 'alert' : 'status'}>{error || '正在准备当前工作区…'}</div>
      {error ? <button className="button" onClick={onRetry}>重试</button> : null}
      <WorkspaceActions action={null} phase="idle" saveBlocked reopenBlocked reopenLabel="重新打开工作区" reopeningWorkspace={false} showReopen onSave={() => {}} onReopen={() => {}} />
    </section>
    <button className="manager-link" disabled>管理工作区 <span>→</span></button>
  </main>;
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.25" />
      <path d="M3.9 12h16.2M12 3.75c2.15 2.27 3.25 5.02 3.25 8.25S14.15 17.98 12 20.25C9.85 17.98 8.75 15.23 8.75 12S9.85 6.02 12 3.75Z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m13.8 3.2 3 3L7.1 15.9l-3.7.7.7-3.7 9.7-9.7Z" />
      <path d="m11.9 5.1 3 3" />
    </svg>
  );
}

function Favicon({ src }: { src?: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [src]);

  return (
    <span className="favicon" aria-hidden="true">
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : <GlobeIcon />}
    </span>
  );
}

function ChangeItem({ change, busy, onOpen }: {
  change: Exclude<TabChange, UpdatedTabChange>;
  busy?: boolean;
  onOpen: (change: TabChange) => void;
}) {
  return (
    <article className="change-item" title={change.title}>
      <Favicon src={change.favIconUrl} />
      <span className="change-copy">
        <strong>{change.title}</strong>
        <span>{getTabDomain(change.url)}</span>
      </span>
      <button className="item-action" disabled={busy} onClick={() => onOpen(change)}>
        {busy ? '正在打开…' : change.kind === 'removed' ? '重新打开' : '查看'}
      </button>
    </article>
  );
}

function UpdatedItem({ change, onOpen }: { change: UpdatedTabChange; onOpen: (change: TabChange) => void }) {
  const urlChanged = change.previous.url !== change.url;
  const titleChanged = change.previous.title !== change.title;
  const pinnedChanged = change.previous.pinned !== change.pinned;

  return (
    <article className="change-item updated-item" title={change.title}>
      <Favicon src={change.favIconUrl} />
      <span className="change-copy update-copy">
        <strong>{change.title}</strong>
        {urlChanged ? (
          <span className="update-detail"><i>上次</i><b>{getTabLocation(change.previous.url)}</b><i>现在</i><b>{getTabLocation(change.url)}</b></span>
        ) : null}
        {!urlChanged && titleChanged ? (
          <span className="update-detail"><i>上次</i><b>{change.previous.title}</b><i>现在</i><b>{change.title}</b></span>
        ) : null}
        {pinnedChanged ? <span className="pin-change">固定状态：{change.previous.pinned ? '已固定' : '未固定'} → {change.pinned ? '已固定' : '未固定'}</span> : null}
      </span>
      <button className="item-action" onClick={() => onOpen(change)}>查看</button>
    </article>
  );
}

function Popup({ accountKey, initial }: { accountKey: string; initial: PopupSnapshot }) {
  const [windowId, setWindowId] = React.useState<number | null>(initial.windowId);
  const [tabs, setTabs] = React.useState<CurrentTabSnapshot[]>(initial.tabs);
  const [record, setRecord] = React.useState<WorkspaceLocalRecord | null>(initial.resolution.record);
  const [resolution, setResolution] = React.useState<WorkspaceWindowResolution | null>(initial.resolution);
  const [name, setName] = React.useState(initial.resolution.record?.content.name ?? '');
  const [status, setStatus] = React.useState<WorkspaceStatus>(initial.resolution.record?.content.status ?? 'active');
  const [page, setPage] = React.useState<'main' | 'details'>('main');
  const [activeKind, setActiveKind] = React.useState<TabChangeKind>('added');
  const [reopening, setReopening] = React.useState('');
  const [reopeningWorkspace, setReopeningWorkspace] = React.useState(false);
  const [saveAction, setSaveAction] = React.useState<SaveAction | null>(null);
  const [savePhase, setSavePhase] = React.useState<SavePhase>('idle');
  const [error, setError] = React.useState(initial.error);
  const [logicalTabsReady, setLogicalTabsReady] = React.useState(initial.logicalTabsReady);
  const [editingName, setEditingName] = React.useState(false);
  const [draftName, setDraftName] = React.useState('');
  const [renameError, setRenameError] = React.useState('');
  const [renaming, setRenaming] = React.useState(false);
  const [success, setSuccess] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);
  const windowIdRef = React.useRef<number | null>(initial.windowId);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const renameSubmittingRef = React.useRef(false);
  const refreshRevision = React.useRef(0);

  const refresh = React.useCallback(async (knownWindowId?: number) => {
    const revision = ++refreshRevision.current;
    setRefreshing(true);
    try {
      const current = await readPopupWindow(knownWindowId);
      const next = await loadPopupWindow(accountKey, current);
      if (revision !== refreshRevision.current) return;
      windowIdRef.current = next.windowId;
      setWindowId(next.windowId);
      setResolution(next.resolution);
      setRecord(next.resolution.record);
      if (next.resolution.record) {
        setName(next.resolution.record.content.name);
        setStatus(next.resolution.record.content.status);
      }
      setTabs(next.tabs);
      setLogicalTabsReady(next.logicalTabsReady);
      setError(next.error);
    } catch (reason) {
      if (revision === refreshRevision.current) {
        setLogicalTabsReady(false);
        setError(reason instanceof Error ? reason.message : '暂时无法读取当前窗口');
      }
    } finally {
      if (revision === refreshRevision.current) setRefreshing(false);
    }
  }, [accountKey]);

  const handleRefreshError = React.useCallback((reason: unknown) => {
    setLogicalTabsReady(false);
    setError(reason instanceof LazyTabResolutionError ? reason.message : '暂时无法读取当前窗口');
  }, []);

  React.useEffect(() => {
    const refreshBoundWindow = (changedWindowId: number) => {
      if (changedWindowId === windowIdRef.current) void refresh(changedWindowId).catch(handleRefreshError);
    };
    const onCreated = (tab: { windowId: number }) => refreshBoundWindow(tab.windowId);
    const onRemoved = (_tabId: number, info: { windowId: number }) => refreshBoundWindow(info.windowId);
    const onUpdated = (_tabId: number, _changeInfo: unknown, tab: { windowId: number }) => refreshBoundWindow(tab.windowId);
    const onMoved = (_tabId: number, info: { windowId: number }) => refreshBoundWindow(info.windowId);
    const onAttached = (_tabId: number, info: { newWindowId: number }) => refreshBoundWindow(info.newWindowId);
    const onDetached = (_tabId: number, info: { oldWindowId: number }) => refreshBoundWindow(info.oldWindowId);
    const storageChanged = (changes: Record<string, unknown>) => {
      if (Object.keys(changes).some((key) => key === accountKey || key === accountKey.replace(/^workspaces/, 'lazyRestoreEntries') || key === accountKey.replace(/^workspaces/, `windowBinding:${windowIdRef.current}`) || key === accountKey.replace(/^workspaces/, `windowBindingSuppressed:${windowIdRef.current}`))) {
        void refresh(windowIdRef.current ?? undefined).catch(handleRefreshError);
      }
    };
    browser.storage.onChanged.addListener(storageChanged);
    browser.tabs.onCreated.addListener(onCreated);
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onMoved.addListener(onMoved);
    browser.tabs.onAttached?.addListener(onAttached);
    browser.tabs.onDetached?.addListener(onDetached);
    return () => {
      browser.storage.onChanged.removeListener(storageChanged);
      browser.tabs.onCreated.removeListener(onCreated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onMoved.removeListener(onMoved);
      browser.tabs.onAttached?.removeListener(onAttached);
      browser.tabs.onDetached?.removeListener(onDetached);
    };
  }, [accountKey, handleRefreshError, refresh]);

  React.useEffect(() => () => { refreshRevision.current++; }, []);

  React.useEffect(() => {
    if (editingName) renameInputRef.current?.select();
  }, [editingName]);

  const diff = React.useMemo(() => calculateTabDiff(record?.content.tabs ?? [], tabs), [record?.content.tabs, tabs]);
  const counts = { added: diff.added.length, removed: diff.removed.length, updated: diff.updated.length };
  const totalChanges = counts.added + counts.removed + counts.updated;
  const availableKinds = (Object.keys(CHANGE_LABELS) as TabChangeKind[]).filter((kind) => counts[kind] > 0);

  React.useEffect(() => {
    if (page !== 'details') return;
    if (totalChanges === 0) setPage('main');
    else if (!availableKinds.includes(activeKind) && availableKinds[0]) setActiveKind(availableKinds[0]);
  }, [activeKind, availableKinds, page, totalChanges]);

  async function openChange(change: TabChange) {
    if (refreshing || windowId == null) return;
    setError('');
    try {
      if (change.kind === 'removed') {
        setReopening(`${change.url}-${change.position}`);
        await reopenSavedTab(windowId, change, accountKey);
        await refresh(windowId);
      } else if (change.tabId != null) {
        await focusWindowTab(windowId, change.tabId, accountKey);
      }
    } catch {
      setError(change.kind === 'removed' ? '无法重新打开该标签页，请重试' : '无法切换到该标签页');
    } finally {
      setReopening('');
    }
  }

  async function submit(closeAfterSave: boolean) {
    if (refreshing || windowId == null || !resolution || !logicalTabsReady) return;
    if (!name.trim()) {
      setError('请输入工作区名称');
      return;
    }
    const action = closeAfterSave ? 'close' : 'save';
    setSaveAction(action);
    setSavePhase('saving');
    setError('');
    try {
      await saveCurrentWindow({ windowId, name, status, closeAfterSave, accountStorageKey: accountKey });
      if (!closeAfterSave) {
        await refresh(windowId);
        setPage('main');
      }
      setSavePhase('idle');
      setSaveAction(null);
      setSuccess('已保存');
    } catch {
      setSavePhase('idle');
      setSaveAction(null);
      setError('保存失败，请重试');
    }
  }

  async function reopen() {
    if (refreshing || windowId == null) return;
    if (resolution?.status === 'unresolved') {
      const url = new URL('/options.html', browser.runtime.getURL('/'));
      url.searchParams.set('recover', '1');
      await browser.tabs.create({ url: url.toString(), active: true });
      return;
    }
    if (resolution?.status !== 'resolved') return;
    setReopeningWorkspace(true);
    setError('');
    try {
      await browser.runtime.sendMessage({
        type: logicalTabsReady ? 'REOPEN_WORKSPACE' : 'RECOVER_WORKSPACE',
        workspaceId: resolution.workspaceId,
        sourceWindowId: windowId,
        accountStorageKey: accountKey,
      });
      setReopeningWorkspace(false);
    } catch {
      setReopeningWorkspace(false);
      setError('无法重新打开工作区，请重试');
    }
  }

  function startRename() {
    if (!record || renaming) return;
    setDraftName(name);
    setRenameError('');
    setEditingName(true);
  }

  function cancelRename() {
    if (renaming || renameSubmittingRef.current) return;
    setEditingName(false);
    setDraftName(name);
    setRenameError('');
  }

  async function submitRename() {
    if (!record || renaming) return;
    const validation = validateWorkspaceName(draftName, name);
    if (validation.error) {
      setRenameError(validation.error);
      return;
    }
    if (!validation.changed) return cancelRename();

    renameSubmittingRef.current = true;
    setRenaming(true);
    setRenameError('');
    try {
      await updateWorkspace(record.content.id, { name: validation.name }, accountKey);
      setName(validation.name);
      setRecord((current) => current ? { ...current, content: { ...current.content, name: validation.name } } : current);
      setEditingName(false);
      setSuccess('已重命名');
    } catch {
      setRenameError('重命名失败，请重试');
    } finally {
      renameSubmittingRef.current = false;
      setRenaming(false);
    }
  }

  const isBound = resolution?.status === 'resolved' && record != null;
  const isUnavailable = resolution?.status === 'unavailable';
  const isUnresolved = resolution?.status === 'unresolved';
  const recovering = !logicalTabsReady;
  const buttons = <WorkspaceActions
    action={saveAction}
    phase={savePhase}
    saveBlocked={refreshing || resolution == null || !logicalTabsReady || isUnavailable}
    reopenBlocked={refreshing || isUnavailable}
    reopenLabel={recovering ? '从已保存工作区恢复' : '重新打开工作区'}
    reopeningWorkspace={reopeningWorkspace}
    showReopen={isBound || isUnresolved}
    onSave={(close) => void submit(close)}
    onReopen={() => void reopen()}
  />;
  const successToast = success ? <SuccessToast message={success} onDismiss={() => setSuccess('')} /> : null;

  if (page === 'details' && isBound) {
    const activeChanges = activeKind === 'added' ? diff.added : activeKind === 'removed' ? diff.removed : diff.updated;
    return (
      <><main className="popup-shell detail-shell">
        {successToast}
        <header className="detail-header">
          <button className="back-button" onClick={() => setPage('main')} aria-label="返回">← <span>返回</span></button>
          <h1>本次保存的变更</h1>
          <span className="header-spacer" />
        </header>
        <nav className="change-tabs" aria-label="变更分类">
          {availableKinds.map((kind) => (
            <button key={kind} className={activeKind === kind ? 'active' : ''} onClick={() => setActiveKind(kind)}>
              {CHANGE_LABELS[kind]} <span>{counts[kind]}</span>
            </button>
          ))}
        </nav>
        <section className="detail-list">
          <p className="change-description">{CHANGE_DESCRIPTIONS[activeKind]}</p>
          <div className="change-list">
            {activeChanges.map((change, index) => change.kind === 'updated'
              ? <UpdatedItem key={`updated-${change.tabId}-${change.position}`} change={change} onOpen={(item) => void openChange(item)} />
              : <ChangeItem key={`${change.kind}-${change.url}-${change.position}-${index}`} change={change} busy={reopening === `${change.url}-${change.position}`} onOpen={(item) => void openChange(item)} />)}
          </div>
        </section>
        <footer className="detail-footer">
          {error ? <div className="inline-error" role="alert">{error}</div> : null}
          {buttons}
        </footer>
      </main></>
    );
  }

  return (
    <main className="popup-shell popup-main-shell" data-popup-state="ready">
      {successToast}
      <header className="popup-header"><Logo /></header>
      <section className="popup-content">
        {resolution == null ? (
          <div className="unchanged-state">正在识别当前工作区…</div>
        ) : isUnavailable ? (
          <div className="unchanged-state">暂时无法读取此工作区，请稍后重试<button className="button" disabled={refreshing} onClick={() => void refresh(windowId ?? undefined)}>重试</button></div>
        ) : isUnresolved ? (
          <div className="unchanged-state">无法可靠识别当前工作区，请从已保存工作区列表中选择恢复。</div>
        ) : isBound ? (
          <div className="bound-summary">
            {editingName ? (
              <input
                ref={renameInputRef}
                className="workspace-name-input"
                value={draftName}
                maxLength={100}
                disabled={renaming}
                aria-label="工作区名称"
                onChange={(event) => { setDraftName(event.target.value); setRenameError(''); }}
                onBlur={cancelRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    void submitRename();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelRename();
                  }
                }}
              />
            ) : (
              <div className="workspace-name-row">
                <button className="workspace-name-button" onClick={startRename} aria-label={`重命名 ${name}`}>
                  <span>{name}</span>
                  <PencilIcon />
                </button>
              </div>
            )}
            {renameError ? <div className="rename-error" role="alert">{renameError}</div> : null}
            <p>当前窗口 · {tabs.length} 个标签页</p>
          </div>
        ) : (
          <>
            <div className="window-summary"><strong>当前窗口</strong><span>{tabs.length} 个标签页</span></div>
            <label className="name-field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="请输入工作区名称" autoFocus /></label>
          </>
        )}

        {isBound ? !logicalTabsReady ? (
          <div className="unchanged-state">当前窗口含异常标签页，保存已禁用。可从已保存版本恢复到新窗口，当前窗口会保留。</div>
        ) : totalChanges === 0 ? (
          <div className="unchanged-state"><span>✓</span> 当前窗口与上次保存一致</div>
        ) : (
          <section className="save-preview">
            <h2>本次保存会更新工作区</h2>
            <dl className="snapshot-counts">
              <div><dt>上次保存</dt><dd>{record.content.tabs.length} 个标签页</dd></div>
              <div><dt>当前窗口</dt><dd>{tabs.length} 个标签页</dd></div>
            </dl>
            <ul className="change-summary">
              {availableKinds.map((kind) => <li key={kind} className={`change-${kind}`}><span aria-hidden="true" />{CHANGE_LABELS[kind]} <b>{counts[kind]}</b> 个</li>)}
            </ul>
            <button className="view-changes" onClick={() => { setActiveKind(availableKinds[0] ?? 'added'); setPage('details'); }}>
              查看本次变更 <span>›</span>
            </button>
          </section>
        ) : null}

        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        {buttons}
      </section>
      <button className="manager-link" onClick={() => void browser.runtime.openOptionsPage()}>管理工作区 <span>→</span></button>
    </main>
  );
}

export function PopupRoot() {
  const { access, checking, message, refresh } = useVerifiedAccess();
  const [setupError, setSetupError] = React.useState('');
  const [snapshot, setSnapshot] = React.useState<{ key: string; value: PopupSnapshot }>();
  const [attempt, setAttempt] = React.useState(0);
  const windowRead = React.useRef<Promise<Browser.windows.Window> | null>(null);
  const windowRevision = React.useRef(0);
  const scopedKey = React.useRef('');
  const currentWindowId = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    // Browser metadata is independent of identity; no workspace data is read here.
    windowRead.current = readPopupWindow();
    void windowRead.current.catch(() => {});
    const invalidate = () => { windowRevision.current++; windowRead.current = null; };
    const storageChanged = (changes: Record<string, unknown>) => {
      const scope = scopedKey.current;
      if (scope && Object.keys(changes).some((key) => [scope, scope.replace(/^workspaces/, 'deleteTombstones'), scope.replace(/^workspaces/, 'lazyRestoreEntries'), scope.replace(/^workspaces/, `windowBinding:${currentWindowId.current}`), scope.replace(/^workspaces/, `windowBindingSuppressed:${currentWindowId.current}`)].includes(key))) invalidate();
    };
    browser.tabs.onCreated.addListener(invalidate);
    browser.tabs.onRemoved.addListener(invalidate);
    browser.tabs.onUpdated.addListener(invalidate);
    browser.tabs.onMoved.addListener(invalidate);
    browser.tabs.onAttached?.addListener(invalidate);
    browser.tabs.onDetached?.addListener(invalidate);
    browser.storage.onChanged.addListener(storageChanged);
    return () => {
      browser.tabs.onCreated.removeListener(invalidate);
      browser.tabs.onRemoved.removeListener(invalidate);
      browser.tabs.onUpdated.removeListener(invalidate);
      browser.tabs.onMoved.removeListener(invalidate);
      browser.tabs.onAttached?.removeListener(invalidate);
      browser.tabs.onDetached?.removeListener(invalidate);
      browser.storage.onChanged.removeListener(storageChanged);
    };
  }, []);
  const config = access?.config;
  const userId = access?.session?.user.id;
  const key = config && userId ? `workspaces:${accountOwner(config.url, userId)}` : '';
  scopedKey.current = key;
  React.useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    setSetupError('');
    if (key) {
      void (async () => {
        for (let retry = 0; active && retry < 3; retry++) {
          const revision = windowRevision.current;
          const read = windowRead.current ?? readPopupWindow();
          windowRead.current = null;
          const current = await read;
          currentWindowId.current = current.id;
          const value = await loadPopupWindow(key, current);
          if (!active) return;
          if (revision !== windowRevision.current) continue;
          setSnapshot({ key, value });
          return;
        }
        if (active) throw new Error('当前窗口持续变化，请稍后重试');
      })().catch((error) => { if (active) setSetupError(error instanceof Error ? error.message : '暂时无法读取当前窗口'); });
    }
    return () => { active = false; };
  }, [key, attempt]);
  React.useLayoutEffect(() => { markPopupCommit(Boolean(key && snapshot?.key === key && !checking)); });
  if (!access || (key && snapshot?.key !== key)) return <PopupPreparing error={setupError || message} onRetry={() => void refresh().then(() => setAttempt((value) => value + 1))} />;
  if (!config || !userId) return <main className="popup-shell">
    <header className="popup-header"><Logo /></header>
    <section className="popup-content popup-setup">
      <h1>连接你的数据存储</h1>
      <p>WindowStash 使用你自己的 Supabase 项目保存工作区。在独立设置标签页中完成配置，切换页面复制信息时，已填写的内容会保留。</p>
      <button className="button button-primary" onClick={() => void browser.runtime.openOptionsPage().catch(() => setSetupError('无法打开设置页，请重试'))}>开始设置</button>
      {setupError || message ? <div className="inline-error" role="alert">{setupError || message}</div> : null}
      <button className="config-tutorial" onClick={() => window.open('/开始使用.html', '_blank', 'noopener,noreferrer')}>查看开始使用教程 <span>↗</span></button>
    </section>
  </main>;
  return <div inert={checking}><Popup key={key} accountKey={key} initial={snapshot!.value} /></div>;
}

startPopupPerformance();
Object.defineProperty(window, 'windowstashPopupPerformance', { value: popupPerformanceSnapshot, configurable: true });
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><PopupRoot /></React.StrictMode>);
