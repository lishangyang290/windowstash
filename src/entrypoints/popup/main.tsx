import React from 'react';
import ReactDOM from 'react-dom/client';
import { browser } from 'wxt/browser';
import { Logo } from '@/components/Logo';
import { SuccessToast } from '@/components/SuccessToast';
import { SupabaseConfigForm } from '@/components/SupabaseConfigForm';
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
  associateExistingWorkspace,
  focusWindowTab,
  listWorkspacesForAssociation,
  reopenSavedTab,
  resolveWorkspaceStateForWindow,
  saveCurrentWindow,
  updateWorkspace,
  type WorkspaceWindowResolution,
} from '@/features/workspaces/workspaceService';
import { LazyTabResolutionError, resolveLogicalTabs } from '@/features/workspaces/lazyRestore';
import { validateWorkspaceName } from '@/features/workspaces/workspaceName';
import type { WorkspaceLocalRecord, WorkspaceStatus } from '@/types/workspace';
import { getSupabaseConfig, type SupabaseConfig } from '@/lib/supabase/client';
import { WorkspaceActions } from './WorkspaceActions';
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

function Popup() {
  const [windowId, setWindowId] = React.useState<number | null>(null);
  const [tabs, setTabs] = React.useState<CurrentTabSnapshot[]>([]);
  const [record, setRecord] = React.useState<WorkspaceLocalRecord | null>(null);
  const [resolution, setResolution] = React.useState<WorkspaceWindowResolution | null>(null);
  const [name, setName] = React.useState('');
  const [status, setStatus] = React.useState<WorkspaceStatus>('active');
  const [page, setPage] = React.useState<'main' | 'details' | 'associate'>('main');
  const [activeKind, setActiveKind] = React.useState<TabChangeKind>('added');
  const [reopening, setReopening] = React.useState('');
  const [reopeningWorkspace, setReopeningWorkspace] = React.useState(false);
  const [saveAction, setSaveAction] = React.useState<SaveAction | null>(null);
  const [savePhase, setSavePhase] = React.useState<SavePhase>('idle');
  const [error, setError] = React.useState('');
  const [logicalTabsReady, setLogicalTabsReady] = React.useState(false);
  const [editingName, setEditingName] = React.useState(false);
  const [draftName, setDraftName] = React.useState('');
  const [renameError, setRenameError] = React.useState('');
  const [renaming, setRenaming] = React.useState(false);
  const [success, setSuccess] = React.useState('');
  const [associationOptions, setAssociationOptions] = React.useState<WorkspaceLocalRecord[]>([]);
  const [associating, setAssociating] = React.useState('');
  const windowIdRef = React.useRef<number | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const renameSubmittingRef = React.useRef(false);

  const refresh = React.useCallback(async (knownWindowId?: number) => {
    const current = knownWindowId == null
      ? await browser.windows.getCurrent({ populate: true })
      : await browser.windows.get(knownWindowId, { populate: true });
    if (current.id == null) throw new Error('Missing window');
    const rawTabs = [...(current.tabs ?? [])].sort((a, b) => a.index - b.index);
    let nextResolution = await resolveWorkspaceStateForWindow(current.id, rawTabs);
    const applyResolution = (value: WorkspaceWindowResolution) => {
      setResolution(value);
      setRecord(value.record);
      if (value.record) {
        setName(value.record.content.name);
        setStatus(value.record.content.status);
      }
    };
    windowIdRef.current = current.id;
    setWindowId(current.id);
    applyResolution(nextResolution);
    try {
      const nextTabs = await resolveLogicalTabs(rawTabs);
      if (nextResolution.status === 'unresolved') {
        nextResolution = await resolveWorkspaceStateForWindow(current.id, nextTabs);
        applyResolution(nextResolution);
      }
      setTabs(nextTabs);
      setLogicalTabsReady(true);
      setError('');
    } catch (reason) {
      setTabs(rawTabs);
      setLogicalTabsReady(false);
      setError(reason instanceof LazyTabResolutionError ? reason.message : '暂时无法读取当前窗口');
    }
  }, []);

  const handleRefreshError = React.useCallback((reason: unknown) => {
    setLogicalTabsReady(false);
    setError(reason instanceof LazyTabResolutionError ? reason.message : '暂时无法读取当前窗口');
  }, []);

  React.useEffect(() => {
    void refresh().catch(handleRefreshError);
    const refreshBoundWindow = (changedWindowId: number) => {
      if (changedWindowId === windowIdRef.current) void refresh(changedWindowId).catch(handleRefreshError);
    };
    const onCreated = (tab: { windowId: number }) => refreshBoundWindow(tab.windowId);
    const onRemoved = (_tabId: number, info: { windowId: number }) => refreshBoundWindow(info.windowId);
    const onUpdated = (_tabId: number, _changeInfo: unknown, tab: { windowId: number }) => refreshBoundWindow(tab.windowId);
    const onMoved = (_tabId: number, info: { windowId: number }) => refreshBoundWindow(info.windowId);
    browser.tabs.onCreated.addListener(onCreated);
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onMoved.addListener(onMoved);
    return () => {
      browser.tabs.onCreated.removeListener(onCreated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onMoved.removeListener(onMoved);
    };
  }, [handleRefreshError, refresh]);

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
    if (windowId == null) return;
    setError('');
    try {
      if (change.kind === 'removed') {
        setReopening(`${change.url}-${change.position}`);
        await reopenSavedTab(windowId, change);
        await refresh(windowId);
      } else if (change.tabId != null) {
        await focusWindowTab(windowId, change.tabId);
      }
    } catch {
      setError(change.kind === 'removed' ? '无法重新打开该标签页，请重试' : '无法切换到该标签页');
    } finally {
      setReopening('');
    }
  }

  async function submit(closeAfterSave: boolean) {
    if (windowId == null) return;
    if (!name.trim()) {
      setError('请输入工作区名称');
      return;
    }
    const action = closeAfterSave ? 'close' : 'save';
    setSaveAction(action);
    setSavePhase('saving');
    setError('');
    try {
      await saveCurrentWindow({ windowId, name, status, closeAfterSave });
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
    if (windowId == null) return;
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
      });
      setReopeningWorkspace(false);
    } catch {
      setReopeningWorkspace(false);
      setError('无法重新打开工作区，请重试');
    }
  }

  async function openAssociationPicker() {
    setError('');
    try {
      setAssociationOptions(await listWorkspacesForAssociation());
      setPage('associate');
    } catch {
      setError('无法读取已保存工作区，请重试');
    }
  }

  async function associate(workspaceId: string) {
    if (windowId == null) return;
    setAssociating(workspaceId);
    setError('');
    try {
      await associateExistingWorkspace(windowId, workspaceId, tabs);
      await refresh(windowId);
      setPage('main');
      setSuccess('已关联工作区');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '关联失败，请重试');
    } finally {
      setAssociating('');
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
      await updateWorkspace(record.content.id, { name: validation.name });
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
    saveBlocked={!logicalTabsReady || isUnavailable}
    reopenBlocked={isUnavailable}
    reopenLabel={recovering ? '从已保存工作区恢复' : '重新打开工作区'}
    reopeningWorkspace={reopeningWorkspace}
    showReopen={isBound || isUnresolved}
    onSave={(close) => void submit(close)}
    onReopen={() => void reopen()}
  />;
  const successToast = success ? <SuccessToast message={success} onDismiss={() => setSuccess('')} /> : null;

  if (page === 'associate') {
    return (
      <main className="popup-shell association-shell">
        <header className="detail-header">
          <button className="back-button" onClick={() => { setPage('main'); setError(''); }} aria-label="返回">← <span>返回</span></button>
          <h1>关联已有工作区</h1>
          <span className="header-spacer" />
        </header>
        <section className="association-content">
          <p>保留当前窗口和全部标签页，只恢复工作区身份。</p>
          <div className="association-list">
            {associationOptions.map((option) => (
              <button key={option.content.id} disabled={Boolean(associating)} onClick={() => void associate(option.content.id)}>
                <span><strong>{option.content.name}</strong><small>{option.content.tabs.length} 个已保存标签页</small></span>
                <b>{associating === option.content.id ? '关联中…' : '关联'}</b>
              </button>
            ))}
            {!associationOptions.length ? <div className="unchanged-state">暂无已保存工作区</div> : null}
          </div>
          {error ? <div className="inline-error" role="alert">{error}</div> : null}
        </section>
      </main>
    );
  }

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
    <main className="popup-shell">
      {successToast}
      <header className="popup-header"><Logo /></header>
      <section className="popup-content">
        {resolution == null ? (
          <div className="unchanged-state">正在识别当前工作区…</div>
        ) : isUnavailable ? (
          <div className="unchanged-state">暂时无法读取此工作区，请稍后重试</div>
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
        {!isBound && !isUnavailable && !isUnresolved ? (
          <button className="associate-link" onClick={() => void openAssociationPicker()}>关联已有工作区</button>
        ) : null}
        {buttons}
      </section>
      <button className="manager-link" onClick={() => void browser.runtime.openOptionsPage()}>管理工作区 <span>→</span></button>
    </main>
  );
}

function PopupRoot() {
  const [config, setConfig] = React.useState<SupabaseConfig | null | undefined>(undefined);
  React.useEffect(() => { void getSupabaseConfig().then(setConfig); }, []);
  if (config === undefined) return <main className="popup-loading">WindowStash</main>;
  if (!config) return <main className="config-page popup-config-page"><SupabaseConfigForm setup onSaved={(next) => {
    setConfig(next);
    void browser.tabs.create({ url: browser.runtime.getURL('/options.html?login=1') }).then(() => window.close());
  }} /></main>;
  return <Popup />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><PopupRoot /></React.StrictMode>);
