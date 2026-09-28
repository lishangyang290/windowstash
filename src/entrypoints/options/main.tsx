import React from 'react';
import ReactDOM from 'react-dom/client';
import type { Session } from '@supabase/supabase-js';
import { browser } from 'wxt/browser';
import { Logo } from '@/components/Logo';
import { deleteWorkspace, openWorkspaceTab, restoreWorkspace, updateWorkspace } from '@/features/workspaces/workspaceService';
import { syncEngine } from '@/lib/sync/syncEngine';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { authService } from '@/lib/supabase/authService';
import { PASSWORD_REQUIREMENTS, passwordChangeErrorMessage, validatePasswordChange } from '@/lib/supabase/passwordPolicy';
import type { StoredTab, SyncLogEntry, WorkspaceLocalRecord } from '@/types/workspace';
import '@/styles/base.css';
import './style.css';

type Filter = 'all' | 'archived';
type ManualSyncState = 'idle' | 'syncing' | 'success' | 'failed';
type PasswordState = 'idle' | 'saving' | 'success';

function formatSavedAt(value: string) {
  const date = new Date(value);
  const today = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === today.toDateString()
    ? `今天 ${time}`
    : `${date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${time}`;
}

function faviconUrl(pageUrl: string) {
  const url = new URL('/_favicon/', browser.runtime.getURL('/options.html'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.toString();
}

function siteFaviconUrl(pageUrl: string) {
  try {
    const url = new URL(pageUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}/favicon.ico` : null;
  } catch {
    return null;
  }
}

function faviconFallback(tab: StoredTab) {
  try {
    const host = new URL(tab.url).hostname.replace(/^www\./, '');
    if (host) return host.slice(0, 1).toUpperCase();
  } catch { /* Use the title for invalid or browser-internal URLs. */ }
  return tab.title.trim().slice(0, 1).toUpperCase() || '•';
}

function TabFavicon({ tab }: { tab: StoredTab }) {
  const sources = [tab.favIconUrl, faviconUrl(tab.url), siteFaviconUrl(tab.url)].filter((source): source is string => Boolean(source));
  const [sourceIndex, setSourceIndex] = React.useState(0);
  const source = sources[sourceIndex];

  React.useEffect(() => setSourceIndex(0), [tab.favIconUrl, tab.url]);

  return <span className="tab-favicon" aria-hidden="true">
    <span>{faviconFallback(tab)}</span>
    {source && <img key={source} src={source} alt="" onError={() => setSourceIndex((index) => index + 1)} />}
  </span>;
}

function TabOverview({ record, onClose }: { record: WorkspaceLocalRecord; onClose: () => void }) {
  const { content } = record;
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  async function openTab(url: string) {
    setError('');
    try {
      await openWorkspaceTab(url);
    } catch {
      setError('这个标签页无法打开');
    }
  }

  return (
    <div className="overview-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="tab-overview" role="dialog" aria-modal="true" aria-labelledby="overview-title">
        <header className="overview-header">
          <div><h2 id="overview-title">{content.name}</h2><p>{error || `${content.tabs.length} 个标签页`}</p></div>
          <button className="overview-close" onClick={onClose} aria-label="关闭标签页速览">×</button>
        </header>
        <div className="overview-grid" aria-label={`${content.name} 的标签页`}>
          {[...content.tabs].sort((a, b) => a.position - b.position).map((tab) => (
            <button className="overview-tab" key={`${tab.position}-${tab.url}`} title={`${tab.title}\n${tab.url}`} onClick={() => void openTab(tab.url)} aria-label={`打开标签页：${tab.title}`}>
              <TabFavicon tab={tab} />
              <span>{tab.title}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function PasswordField({ label, value, onChange, autoComplete, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  disabled: boolean;
}) {
  const id = React.useId();
  const [visible, setVisible] = React.useState(false);
  const actionLabel = visible ? '隐藏密码' : '显示密码';

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-input-wrap">
        <input id={id} type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} disabled={disabled} />
        <button className="password-visibility" type="button" onClick={() => setVisible((current) => !current)} aria-label={actionLabel} title={actionLabel} aria-pressed={visible} disabled={disabled}>
          {visible ? (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9 8 9 8a17.8 17.8 0 0 1-2.1 3.2M6.6 6.6C4.2 8.2 3 12 3 12s3.5 8 9 8a9.8 9.8 0 0 0 4.1-.9" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12s3.5-8 9-8 9 8 9 8-3.5 8-9 8-9-8-9-8Z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </div>
    </div>
  );
}

function AccountDialog({
  session,
  logs,
  onClose,
  onChanged,
  onClearLogs,
}: {
  session: Session | null;
  logs: SyncLogEntry[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onClearLogs: () => Promise<void>;
}) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [passwordState, setPasswordState] = React.useState<PasswordState>('idle');
  const passwordRequirementsMet = PASSWORD_REQUIREMENTS.every(({ test }) => test(newPassword));

  async function auth(mode: 'login' | 'register') {
    setBusy(true);
    setMessage('');
    try {
      const next = mode === 'login' ? await authService.signIn(email, password) : await authService.signUp(email, password);
      setMessage(next ? '登录成功。' : '注册成功，请查收验证邮件。');
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  function passwordUpdated() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordState('success');
    setMessage('密码已修改，你现在可以使用新密码登录 WindowStash Companion。');
  }

  async function savePassword() {
    const validationError = validatePasswordChange(currentPassword, newPassword, confirmPassword);
    if (validationError) return setMessage(validationError);
    setPasswordState('saving');
    setMessage('');
    try {
      await authService.updatePassword(currentPassword, newPassword);
      passwordUpdated();
    } catch (error) {
      setPasswordState('idle');
      setMessage(passwordChangeErrorMessage(error));
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <div className="dialog-head">
          <div><h2 id="account-title">{session ? '账户设置' : '账户'}</h2><p>{session ? '管理你的 WindowStash 账户。' : '登录后可在其他设备使用已保存的窗口。'}</p></div>
          <button className="close-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {session ? (
          <div className="account-settings">
            <div className="account-email"><span>邮箱</span><strong>{session.user.email}</strong></div>
            <form className="password-form" onSubmit={(event) => { event.preventDefault(); void savePassword(); }}>
              <h3>修改密码</h3>
              <PasswordField label="当前密码" value={currentPassword} onChange={(value) => { setCurrentPassword(value); setPasswordState('idle'); setMessage(''); }} autoComplete="current-password" disabled={passwordState === 'saving'} />
              <PasswordField label="新密码" value={newPassword} onChange={(value) => { setNewPassword(value); setPasswordState('idle'); setMessage(''); }} autoComplete="new-password" disabled={passwordState === 'saving'} />
              <div className="password-requirements">
                <strong>密码要求</strong>
                <ul>{PASSWORD_REQUIREMENTS.map(({ label, test }) => { const met = test(newPassword); return <li className={met ? 'met' : ''} key={label}><span>{met ? '✓' : '○'}</span>{label}</li>; })}</ul>
              </div>
              <PasswordField label="确认新密码" value={confirmPassword} onChange={(value) => { setConfirmPassword(value); setPasswordState('idle'); setMessage(''); }} autoComplete="new-password" disabled={passwordState === 'saving'} />
              <button className="button button-primary" type="submit" disabled={passwordState === 'saving' || !passwordRequirementsMet}>{passwordState === 'saving' ? '正在修改…' : passwordState === 'success' ? '✓ 密码已修改' : '修改密码'}</button>
            </form>
          </div>
        ) : (
          <div className="auth-form">
            <label className="field"><span>邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
            <label className="field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
            <div className="auth-actions"><button className="button button-primary" disabled={busy || !email || password.length < 6} onClick={() => void auth('login')}>登录</button><button className="button" disabled={busy || !email || password.length < 6} onClick={() => void auth('register')}>注册</button></div>
          </div>
        )}
        {message && <p className={`dialog-message${passwordState === 'success' ? ' success' : ''}`} role={passwordState === 'success' ? 'status' : 'alert'}>{message}</p>}
        <details className="diagnostics">
          <summary>诊断日志</summary>
          <div className="diagnostics-head"><span>最近 {logs.length} 条记录</span>{logs.length > 0 && <button onClick={() => void onClearLogs()}>清空</button>}</div>
          <div className="diagnostics-list">
            {logs.length ? logs.slice(0, 20).map((log) => <div key={log.id}><time>{new Date(log.timestamp).toLocaleString('zh-CN')}</time><strong>{log.workspaceName}</strong><span>{log.message}</span></div>) : <p>暂无记录</p>}
          </div>
        </details>
      </section>
    </div>
  );
}

function WorkspaceRow({ record, onRefresh }: { record: WorkspaceLocalRecord; onRefresh: () => Promise<unknown> }) {
  const { content } = record;
  const [busy, setBusy] = React.useState<'open' | 'update' | null>(null);
  const [overviewOpen, setOverviewOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draftName, setDraftName] = React.useState(content.name);
  const [error, setError] = React.useState('');

  async function run(task: () => Promise<void>, action: 'open' | 'update' = 'update') {
    setBusy(action);
    setMenuOpen(false);
    setError('');
    try {
      await task();
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试');
    } finally {
      setBusy(null);
    }
  }

  function saveName() {
    const name = draftName.trim();
    if (!name || name === content.name) return setEditing(false);
    void run(async () => {
      await updateWorkspace(content.id, { name });
      setEditing(false);
    });
  }

  function remove() {
    setMenuOpen(false);
    if (window.confirm(`确定删除“${content.name}”？`)) void run(() => deleteWorkspace(content.id));
  }

  const archived = content.status === 'archived';
  return (
    <article className="workspace-row">
      <div className="workspace-row-main">
        <div className="workspace-leading">
          <div className="workspace-icon" aria-hidden="true">{content.name.slice(0, 1).toUpperCase()}</div>
          <div className="workspace-copy">
            {editing ? (
              <input
                className="rename-input"
                autoFocus
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={saveName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveName();
                  if (event.key === 'Escape') { setDraftName(content.name); setEditing(false); }
                }}
                aria-label="Workspace 名称"
              />
            ) : <button className="workspace-name" disabled={Boolean(busy)} onClick={() => setEditing(true)} title="点击重命名">{content.name}</button>}
            <p className="workspace-meta">{content.tabs.length} 个标签页 · {formatSavedAt(content.updatedAt)} 保存</p>
            {error && <span className="row-error" role="alert">{error}</span>}
          </div>
        </div>
        <div className="workspace-actions">
          <button className="overview-button" onClick={() => setOverviewOpen(true)}>查看标签页</button>
          <button className="open-button" disabled={Boolean(busy)} onClick={() => void run(() => restoreWorkspace(content.id).then(() => undefined), 'open')}>{busy === 'open' ? '正在打开…' : '打开'}</button>
          <div className="more-wrap">
            <button className="more-button" aria-label={`更多操作：${content.name}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>•••</button>
            {menuOpen && <div className="more-menu">
              <button onClick={() => void run(() => updateWorkspace(content.id, { status: archived ? 'active' : 'archived' }))}>{archived ? '取消归档' : '归档'}</button>
              <span />
              <button className="delete-action" onClick={remove}>删除</button>
            </div>}
          </div>
        </div>
      </div>
      {overviewOpen && <TabOverview record={record} onClose={() => setOverviewOpen(false)} />}
    </article>
  );
}

function SyncIssues({ records, onRefresh, onClose }: { records: WorkspaceLocalRecord[]; onRefresh: () => Promise<unknown>; onClose: () => void }) {
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function resolve(id: string, choice: 'local' | 'cloud') {
    setBusyId(id);
    try {
      await syncEngine.resolveConflict(id, choice);
      await onRefresh();
      if (records.length === 1) onClose();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="sync-issues" aria-label="同步问题处理">
      <div className="sync-issues-head"><div><h2>需要处理的工作区</h2><p>选择要保留的内容。</p></div><button onClick={onClose}>关闭</button></div>
      {records.map(({ content }) => <div className="sync-issue-row" key={content.id}><strong>{content.name}</strong><div><button className="button" disabled={busyId === content.id} onClick={() => void resolve(content.id, 'local')}>保留本机内容</button><button className="button button-primary" disabled={busyId === content.id} onClick={() => void resolve(content.id, 'cloud')}>保留云端内容</button></div></div>)}
    </section>
  );
}

function Dashboard() {
  const [records, setRecords] = React.useState<WorkspaceLocalRecord[]>([]);
  const [logs, setLogs] = React.useState<SyncLogEntry[]>([]);
  const [session, setSession] = React.useState<Session | null>(null);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [query, setQuery] = React.useState('');
  const [accountOpen, setAccountOpen] = React.useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);
  const [issuesOpen, setIssuesOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [manualSyncState, setManualSyncState] = React.useState<ManualSyncState>('idle');
  const syncSuccessTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = React.useCallback(async () => {
    const [nextRecords, nextLogs, nextSession] = await Promise.all([workspaceRepository.list(), syncLogRepository.list(), authService.session()]);
    setRecords(nextRecords);
    setLogs(nextLogs);
    setSession(nextSession);
    setLoading(false);
    return { records: nextRecords, session: nextSession };
  }, []);

  React.useEffect(() => {
    void refresh();
    void browser.runtime.sendMessage({ type: 'SYNC_ALL' });
    const listener = () => void refresh();
    browser.storage.onChanged.addListener(listener);
    return () => {
      browser.storage.onChanged.removeListener(listener);
      if (syncSuccessTimer.current) clearTimeout(syncSuccessTimer.current);
    };
  }, [refresh]);

  const normalRecords = records.filter(({ content }) => content.status !== 'archived');
  const archivedRecords = records.filter(({ content }) => content.status === 'archived');
  const conflicts = records.filter(({ sync }) => sync.syncStatus === 'conflict');
  const unsyncedRecords = records.filter(({ sync }) => sync.syncStatus === 'pending' || sync.syncStatus === 'failed');
  const baseRecords = filter === 'archived' ? archivedRecords : normalRecords;
  const filtered = baseRecords.filter(({ content }) => content.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  async function authChanged() {
    const next = await refresh();
    if (next.session) {
      await syncEngine.syncAll();
      await refresh();
    }
  }

  async function syncNow() {
    if (manualSyncState === 'syncing') return;
    if (!session) {
      setAccountOpen(true);
      return;
    }
    if (syncSuccessTimer.current) clearTimeout(syncSuccessTimer.current);
    setManualSyncState('syncing');
    try {
      await syncEngine.syncAll();
      const next = await refresh();
      const remaining = next.records.filter(({ sync }) => sync.syncStatus === 'pending' || sync.syncStatus === 'failed');
      if (remaining.length > 0) {
        setManualSyncState('failed');
        return;
      }
      setManualSyncState('success');
      syncSuccessTimer.current = setTimeout(() => setManualSyncState('idle'), 2000);
    } catch {
      setManualSyncState('failed');
      await refresh();
    }
  }

  async function logout() {
    setAccountMenuOpen(false);
    await authService.signOut();
    await refresh();
  }

  const unsyncedMessage = unsyncedRecords.length > 1 || manualSyncState === 'failed'
    ? `${unsyncedRecords.length} 个工作区暂未同步，数据已保存在本机。`
    : '云端暂未同步，数据已保存在本机。';

  return (
    <div className="app-shell">
      <main className="dashboard">
        <header className="dashboard-heading">
          <div className="title-block"><Logo /><p>保存窗口，需要时继续。</p></div>
          <div className="header-actions">
            <label className="search-wrap"><span aria-hidden="true">⌕</span><span className="sr-only">搜索工作区</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区" /></label>
            <button className="header-sync-button" disabled={manualSyncState === 'syncing'} onClick={() => void syncNow()}>
              {manualSyncState === 'syncing' ? '正在同步…' : manualSyncState === 'failed' ? '重试同步' : '立即同步'}
            </button>
            <div className="account-wrap" onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setAccountMenuOpen(false); }}>
              <button className="account-button" aria-haspopup={session ? 'menu' : undefined} aria-expanded={session ? accountMenuOpen : undefined} onClick={() => session ? setAccountMenuOpen((open) => !open) : setAccountOpen(true)}><span className="avatar">{session?.user.email?.[0]?.toUpperCase() ?? '?'}</span><span>{session?.user.email ?? '登录'}</span></button>
              {session && accountMenuOpen && <div className="account-menu" role="menu">
                <button role="menuitem" onClick={() => { setAccountMenuOpen(false); setAccountOpen(true); }}>账户设置</button>
                <button role="menuitem" onClick={() => void logout()}>退出登录</button>
              </div>}
            </div>
          </div>
        </header>

        {(unsyncedRecords.length > 0 || conflicts.length > 0) && <div className="notices" aria-live="polite">
          {unsyncedRecords.length > 0 && <div className="quiet-notice sync-notice">
            <span aria-hidden="true">↗</span>
            <p>{session ? unsyncedMessage : '云端同步需要登录'}</p>
            {!session && <button className="notice-button" onClick={() => setAccountOpen(true)}>登录</button>}
          </div>}
          {conflicts.length > 0 && <button className="quiet-notice notice-action" onClick={() => setIssuesOpen(true)}><span aria-hidden="true">•</span><p>有 {conflicts.length} 个工作区需要处理同步问题</p><strong>处理</strong></button>}
        </div>}

        {issuesOpen && <SyncIssues records={conflicts} onRefresh={refresh} onClose={() => setIssuesOpen(false)} />}

        <nav className="filterbar" aria-label="工作区筛选">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 <span>{normalRecords.length}</span></button>
          <button className={filter === 'archived' ? 'active' : ''} onClick={() => setFilter('archived')}>已归档 <span>{archivedRecords.length}</span></button>
        </nav>

        <section className="workspace-list" aria-live="polite">
          {loading ? <div className="loading-list">{[0, 1, 2].map((item) => <div key={item}><span /><p /><button /></div>)}</div> : filtered.length ? filtered.map((record) => <WorkspaceRow key={record.content.id} record={record} onRefresh={refresh} />) : <div className="empty-state"><div className="empty-icon">□</div><h2>{query ? '没有找到工作区' : filter === 'archived' ? '没有已归档的工作区' : '还没有保存窗口'}</h2><p>{query ? '试试其他名称。' : filter === 'archived' ? '归档的工作区会显示在这里。' : '点击浏览器工具栏中的 WindowStash 开始保存。'}</p></div>}
        </section>
      </main>
      {manualSyncState === 'success' && <div className="sync-toast" role="status" aria-live="polite"><span aria-hidden="true">✓</span>已同步到云端</div>}
      {accountOpen && <AccountDialog session={session} logs={logs} onClose={() => setAccountOpen(false)} onChanged={authChanged} onClearLogs={async () => { await syncLogRepository.clear(); await refresh(); }} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Dashboard /></React.StrictMode>);
