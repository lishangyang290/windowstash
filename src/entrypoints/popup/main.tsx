import React from 'react';
import ReactDOM from 'react-dom/client';
import { browser } from 'wxt/browser';
import { Logo } from '@/components/Logo';
import { calculateTabDiff, getTabDomain, type CurrentTabSnapshot, type TabChange } from '@/features/workspaces/tabDiff';
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

function ChangeItem({ change, onOpen }: { change: TabChange; onOpen: (change: TabChange) => void }) {
  return (
    <button className="change-item" onClick={() => onOpen(change)} title={change.title}>
      <Favicon src={change.favIconUrl} />
      <span className="change-copy">
        <strong>{change.title}</strong>
        <span>{getTabDomain(change.url)}</span>
      </span>
    </button>
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
      <button className="button button-primary" disabled={phase !== 'idle'} onClick={() => onSave(false)}>
        {label('save', '保存当前状态')}
      </button>
      <button className="button" disabled={phase !== 'idle'} onClick={() => onSave(true)}>
        {label('close', '保存并关闭窗口')}
      </button>
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
      if (changedWindowId === windowIdRef.current) {
        void refresh(changedWindowId).catch(() => setError('暂时无法更新窗口状态'));
      }
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

  const diff = React.useMemo(
    () => calculateTabDiff(record?.content.tabs ?? [], tabs),
    [record?.content.tabs, tabs],
  );
  const changes: TabChange[] = React.useMemo(() => [...diff.added, ...diff.closed], [diff]);

  async function openChange(change: TabChange) {
    if (windowId == null) return;
    setError('');
    try {
      if (change.kind === 'added') {
        if (change.tabId != null) await focusWindowTab(windowId, change.tabId);
      } else {
        await reopenSavedTab(windowId, change);
        await refresh(windowId);
      }
    } catch {
      setError(change.kind === 'added' ? '无法切换到该标签页' : '无法恢复该标签页，请重试');
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
  const totalChanges = changes.length;
  const buttons = <SaveButtons action={saveAction} phase={savePhase} onSave={(close) => void submit(close)} />;

  if (page === 'details' && isBound) {
    return (
      <main className="popup-shell detail-shell">
        <header className="detail-header">
          <button className="back-button" onClick={() => setPage('main')} aria-label="返回">← <span>返回</span></button>
          <h1>变更详情</h1>
          <span className="header-spacer" />
        </header>
        <div className="detail-counts" aria-label={`新增 ${diff.added.length}，关闭 ${diff.closed.length}`}>
          <span><b>新增</b> {diff.added.length}</span>
          <span><b>关闭</b> {diff.closed.length}</span>
        </div>
        <div className="detail-list">
          {diff.added.length > 0 ? (
            <section className="change-group">
              <h2>新增</h2>
              {diff.added.map((change) => <ChangeItem key={`added-${change.tabId}-${change.position}`} change={change} onOpen={(item) => void openChange(item)} />)}
            </section>
          ) : null}
          {diff.closed.length > 0 ? (
            <section className="change-group">
              <h2>关闭</h2>
              {diff.closed.map((change, index) => <ChangeItem key={`closed-${change.url}-${change.position}-${index}`} change={change} onOpen={(item) => void openChange(item)} />)}
            </section>
          ) : null}
          {totalChanges === 0 ? <p className="empty-detail">✓ 与上次保存一致</p> : null}
        </div>
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

        {isBound ? (
          totalChanges === 0 ? (
            <div className="unchanged-state"><span>✓</span> 与上次保存一致</div>
          ) : (
            <section className="diff-summary">
              <h2>与上次保存相比</h2>
              <div className="diff-counts">
                <span className="added-count">+{diff.added.length} 新增</span>
                <span className="closed-count">-{diff.closed.length} 关闭</span>
              </div>
              <div className="preview-list">
                {changes.slice(0, 2).map((change, index) => (
                  <ChangeItem key={`${change.kind}-${change.url}-${change.position}-${index}`} change={change} onOpen={(item) => void openChange(item)} />
                ))}
              </div>
              <button className="view-all" onClick={() => setPage('details')}>查看全部 {totalChanges} 项变更 <span>›</span></button>
            </section>
          )
        ) : null}

        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        {buttons}
      </section>
      <button className="manager-link" onClick={() => void browser.runtime.openOptionsPage()}>管理工作区 <span>→</span></button>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Popup /></React.StrictMode>);
