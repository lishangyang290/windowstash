import React from 'react';
import ReactDOM from 'react-dom/client';
import { browser } from 'wxt/browser';
import { Logo } from '@/components/Logo';
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
  getCurrentWindowSnapshot,
  reopenSavedTab,
  resolveWorkspaceForWindow,
  saveCurrentWindow,
} from '@/features/workspaces/workspaceService';
import type { WorkspaceLocalRecord, WorkspaceStatus } from '@/types/workspace';
import '@/styles/base.css';
import './style.css';

type SaveAction = 'save' | 'close';
type SavePhase = 'idle' | 'saving' | 'saved';

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

function SaveButtons({ action, phase, onSave }: {
  action: SaveAction | null;
  phase: SavePhase;
  onSave: (closeAfterSave: boolean) => void;
}) {
  const label = (buttonAction: SaveAction, idleLabel: string) => {
    if (action !== buttonAction) return idleLabel;
    if (phase === 'saving') return '正在保存…';
    if (phase === 'saved') return '✓ 已保存';
    return idleLabel;
  };

  return (
    <div className="popup-actions">
      <button className="button button-primary" disabled={phase !== 'idle'} onClick={() => onSave(false)}>{label('save', '保存当前状态')}</button>
      <button className="button" disabled={phase !== 'idle'} onClick={() => onSave(true)}>{label('close', '保存并关闭窗口')}</button>
    </div>
  );
}

function Popup() {
  const [windowId, setWindowId] = React.useState<number | null>(null);
  const [tabs, setTabs] = React.useState<CurrentTabSnapshot[]>([]);
  const [record, setRecord] = React.useState<WorkspaceLocalRecord | null>(null);
  const [name, setName] = React.useState('');
  const [status, setStatus] = React.useState<WorkspaceStatus>('active');
  const [page, setPage] = React.useState<'main' | 'details'>('main');
  const [activeKind, setActiveKind] = React.useState<TabChangeKind>('added');
  const [reopening, setReopening] = React.useState('');
  const [saveAction, setSaveAction] = React.useState<SaveAction | null>(null);
  const [savePhase, setSavePhase] = React.useState<SavePhase>('idle');
  const [error, setError] = React.useState('');
  const windowIdRef = React.useRef<number | null>(null);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = React.useCallback(async (knownWindowId?: number) => {
    const snapshot = knownWindowId == null
      ? await getCurrentWindowSnapshot()
      : await browser.windows.get(knownWindowId, { populate: true }).then((window) => {
        if (window.id == null) throw new Error('Missing window');
        return { windowId: window.id, tabs: window.tabs ?? [] };
      });
    const nextTabs = [...(snapshot.tabs ?? [])].sort((a, b) => a.index - b.index);
    const nextRecord = await resolveWorkspaceForWindow(snapshot.windowId, nextTabs);
    windowIdRef.current = snapshot.windowId;
    setWindowId(snapshot.windowId);
    setTabs(nextTabs);
    setRecord(nextRecord);
    if (nextRecord) {
      setName(nextRecord.content.name);
      setStatus(nextRecord.content.status);
    }
  }, []);

  React.useEffect(() => {
    void refresh().catch(() => setError('暂时无法读取当前窗口'));
    const refreshBoundWindow = (changedWindowId: number) => {
      if (changedWindowId === windowIdRef.current) void refresh(changedWindowId).catch(() => setError('暂时无法更新窗口状态'));
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
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, [refresh]);

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
      setSavePhase('saved');
      resetTimer.current = setTimeout(() => {
        setSavePhase('idle');
        setSaveAction(null);
      }, 1000);
    } catch {
      setSavePhase('idle');
      setSaveAction(null);
      setError('保存失败，请重试');
    }
  }

  const isBound = record != null;
  const buttons = <SaveButtons action={saveAction} phase={savePhase} onSave={(close) => void submit(close)} />;

  if (page === 'details' && isBound) {
    const activeChanges = activeKind === 'added' ? diff.added : activeKind === 'removed' ? diff.removed : diff.updated;
    return (
      <main className="popup-shell detail-shell">
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
      </main>
    );
  }

  return (
    <main className="popup-shell">
      <header className="popup-header"><Logo /></header>
      <section className="popup-content">
        {isBound ? (
          <div className="bound-summary">
            <h1>{name}</h1>
            <p>当前窗口 · {tabs.length} 个标签页</p>
          </div>
        ) : (
          <>
            <div className="window-summary"><strong>当前窗口</strong><span>{tabs.length} 个标签页</span></div>
            <label className="name-field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：PetLifeHub 首页" autoFocus /></label>
          </>
        )}

        {isBound ? totalChanges === 0 ? (
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

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Popup /></React.StrictMode>);
