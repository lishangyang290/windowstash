import React from 'react';
import ReactDOM from 'react-dom/client';
import type { Session } from '@supabase/supabase-js';
import { browser } from 'wxt/browser';
import { Logo } from '@/components/Logo';
import { SuccessToast } from '@/components/SuccessToast';
import { SupabaseConfigForm } from '@/components/SupabaseConfigForm';
import { VisibilityToggleInput } from '@/components/VisibilityToggleInput';
import { deleteWorkspace, openWorkspaceTab, updateWorkspace } from '@/features/workspaces/workspaceService';
import { syncEngine } from '@/lib/sync/syncEngine';
import { syncLogRepository } from '@/lib/storage/syncLogRepository';
import { workspaceRepository } from '@/lib/storage/workspaceRepository';
import { authService } from '@/lib/supabase/authService';
import { getSupabaseConfig, type SupabaseConfig } from '@/lib/supabase/client';
import { isValidEmail, PASSWORD_REQUIREMENTS, passwordChangeErrorMessage, passwordRequirementsMet, registrationErrorMessage, validatePasswordChange, validateRegistration } from '@/lib/supabase/passwordPolicy';
import type { StoredTab, SyncLogEntry, WorkspaceLocalRecord } from '@/types/workspace';
import '@/styles/base.css';
import './style.css';

type Filter = 'all' | 'archived';
type ManualSyncState = 'idle' | 'syncing' | 'success' | 'failed';
type PasswordState = 'idle' | 'saving';

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

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <VisibilityToggleInput id={id} value={value} onChange={onChange} autoComplete={autoComplete} disabled={disabled} />
    </div>
  );
}

function AccountDialog({
  session,
  onClose,
  onChanged,
}: {
  session: Session | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [registrationConfirmPassword, setRegistrationConfirmPassword] = React.useState('');
  const [authMode, setAuthMode] = React.useState<'login' | 'register'>('login');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [success, setSuccess] = React.useState('');
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [passwordState, setPasswordState] = React.useState<PasswordState>('idle');
  const newPasswordRequirementsMet = passwordRequirementsMet(newPassword);

  async function auth() {
    if (!isValidEmail(email)) return setMessage('请输入有效邮箱');
    if (authMode === 'register') {
      const validationError = validateRegistration(email, password, registrationConfirmPassword);
      if (validationError) return setMessage(validationError);
    }
    setBusy(true);
    setMessage('');
    setSuccess('');
    try {
      const next = authMode === 'login' ? await authService.signIn(email, password) : await authService.signUp(email, password);
      if (next) {
        onClose();
        await onChanged();
        return;
      }
      await onChanged();
      setSuccess('注册成功，请查收验证邮件');
    } catch (error) {
      setMessage(authMode === 'register' ? registrationErrorMessage(error) : error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  function passwordUpdated() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordState('idle');
    setSuccess('密码已修改');
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
      {success ? <SuccessToast message={success} onDismiss={() => setSuccess('')} /> : null}
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <div className="dialog-head">
          <div><h2 id="account-title">{session ? '修改密码' : authMode === 'login' ? '登录' : '注册'}</h2><p>{session ? '修改当前 WindowStash 账号的登录密码。' : authMode === 'login' ? '登录后可在其他设备使用已保存的窗口。' : '创建用于 WindowStash 同步的账号。'}</p></div>
          <button className="close-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {session ? (
          <div className="account-settings">
            <div className="account-email"><span>邮箱</span><strong>{session.user.email}</strong></div>
            <form className="password-form" onSubmit={(event) => { event.preventDefault(); void savePassword(); }}>
              <PasswordField label="当前密码" value={currentPassword} onChange={(value) => { setCurrentPassword(value); setPasswordState('idle'); setMessage(''); }} autoComplete="current-password" disabled={passwordState === 'saving'} />
              <PasswordField label="新密码" value={newPassword} onChange={(value) => { setNewPassword(value); setPasswordState('idle'); setMessage(''); }} autoComplete="new-password" disabled={passwordState === 'saving'} />
              <div className="password-requirements">
                <strong>密码要求</strong>
                <ul>{PASSWORD_REQUIREMENTS.map(({ label, test }) => { const met = test(newPassword); return <li className={met ? 'met' : ''} key={label}><span>{met ? '✓' : '○'}</span>{label}</li>; })}</ul>
              </div>
              <PasswordField label="确认新密码" value={confirmPassword} onChange={(value) => { setConfirmPassword(value); setPasswordState('idle'); setMessage(''); }} autoComplete="new-password" disabled={passwordState === 'saving'} />
              <button className="button button-primary" type="submit" disabled={passwordState === 'saving' || !newPasswordRequirementsMet}>{passwordState === 'saving' ? '正在修改…' : '修改密码'}</button>
            </form>
          </div>
        ) : (
          <form className="auth-form" noValidate onSubmit={(event) => { event.preventDefault(); void auth(); }}>
            <label className="field"><span>邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
            <label className="field"><span>密码</span><VisibilityToggleInput value={password} onChange={setPassword} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} /></label>
            {authMode === 'register' ? <>
              <label className="field"><span>确认密码</span><VisibilityToggleInput value={registrationConfirmPassword} onChange={setRegistrationConfirmPassword} autoComplete="new-password" /></label>
              <div className="password-requirements"><strong>密码需要：</strong><ul>{PASSWORD_REQUIREMENTS.map(({ label, test }) => { const met = test(password); return <li className={met ? 'met' : ''} key={label}><span>{met ? '✓' : '○'}</span>{label}</li>; })}</ul></div>
            </> : null}
            <button className="button button-primary" disabled={busy || !email || !password || (authMode === 'register' && !registrationConfirmPassword)}>{busy ? authMode === 'login' ? '正在登录…' : '正在注册…' : authMode === 'login' ? '登录' : '注册'}</button>
            <p className="auth-switch">{authMode === 'login' ? '还没有账号？' : '已有账号？'}<button type="button" onClick={() => { setAuthMode((mode) => mode === 'login' ? 'register' : 'login'); setPassword(''); setRegistrationConfirmPassword(''); setMessage(''); }}>{authMode === 'login' ? '注册' : '登录'}</button></p>
          </form>
        )}
        {message ? <p className="dialog-message" role="alert">{message}</p> : null}
      </section>
    </div>
  );
}

function DiagnosticsDialog({ logs, onClose, onClear }: { logs: SyncLogEntry[]; onClose: () => void; onClear: () => Promise<void> }) {
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog diagnostics-dialog" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title">
        <div className="dialog-head">
          <div><h2 id="diagnostics-title">诊断日志</h2><p>用于排查 Workspace 同步问题。</p></div>
          <button className="close-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="diagnostics-head"><span>最近 {logs.length} 条记录</span>{logs.length > 0 && <button onClick={() => void onClear()}>清空日志</button>}</div>
        <div className="diagnostics-list">
          {logs.length ? logs.slice(0, 20).map((log) => <div key={log.id}><time>{new Date(log.timestamp).toLocaleString('zh-CN')}</time><strong>{log.workspaceName}</strong><span>{log.message}</span></div>) : <p>暂无诊断记录</p>}
        </div>
      </section>
    </div>
  );
}

function WorkspaceRow({ record, recoveryMode, onRefresh }: { record: WorkspaceLocalRecord; recoveryMode: boolean; onRefresh: () => Promise<unknown> }) {
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
  const openMessage = recoveryMode
    ? { type: 'RESTORE_SAVED_WORKSPACE' as const, workspaceId: content.id }
    : { type: 'OPEN_OR_FOCUS_WORKSPACE' as const, workspaceId: content.id };
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
          <button className="open-button" disabled={Boolean(busy)} onClick={() => void run(() => browser.runtime.sendMessage(openMessage).then(() => undefined), 'open')}>{busy === 'open' ? '正在恢复…' : recoveryMode ? '从保存版本恢复' : '打开'}</button>
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

function Dashboard({ config, initialAccountOpen, recoveryMode, onConfigChanged }: { config: SupabaseConfig; initialAccountOpen: boolean; recoveryMode: boolean; onConfigChanged: (config: SupabaseConfig) => void }) {
  const [records, setRecords] = React.useState<WorkspaceLocalRecord[]>([]);
  const [logs, setLogs] = React.useState<SyncLogEntry[]>([]);
  const [session, setSession] = React.useState<Session | null>(null);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [query, setQuery] = React.useState('');
  const [accountOpen, setAccountOpen] = React.useState(initialAccountOpen);
  const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
  const [connectionOpen, setConnectionOpen] = React.useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);
  const [issuesOpen, setIssuesOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [manualSyncState, setManualSyncState] = React.useState<ManualSyncState>('idle');

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
            <button className="header-sync-button" onClick={() => window.open('/开始使用.html', '_blank', 'noopener,noreferrer')}>使用教程</button>
            <button className="header-sync-button" disabled={manualSyncState === 'syncing'} onClick={() => void syncNow()}>
              {manualSyncState === 'syncing' ? '正在同步…' : manualSyncState === 'failed' ? '重试同步' : '立即同步'}
            </button>
            <button className="header-sync-button" onClick={() => setConnectionOpen(true)}>数据存储</button>
            <div className="account-wrap" onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setAccountMenuOpen(false); }}>
              <button className="account-button" aria-haspopup={session ? 'menu' : undefined} aria-expanded={session ? accountMenuOpen : undefined} onClick={() => session ? setAccountMenuOpen((open) => !open) : setAccountOpen(true)}><span className="avatar">{session?.user.email?.[0]?.toUpperCase() ?? '?'}</span><span>{session?.user.email ?? '登录'}</span></button>
              {session && accountMenuOpen && <div className="account-menu" role="menu">
                <button role="menuitem" onClick={() => { setAccountMenuOpen(false); setAccountOpen(true); }}>修改密码</button>
                <button role="menuitem" onClick={() => { setAccountMenuOpen(false); setDiagnosticsOpen(true); }}>诊断日志</button>
                <button role="menuitem" onClick={() => void logout()}>退出登录</button>
              </div>}
            </div>
          </div>
        </header>

        {recoveryMode && <div className="notices"><div className="quiet-notice"><span aria-hidden="true">↗</span><p>选择一个已保存工作区恢复到新窗口；当前异常窗口会保留。</p></div></div>}

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
          {loading ? <div className="loading-list">{[0, 1, 2].map((item) => <div key={item}><span /><p /><button /></div>)}</div> : filtered.length ? filtered.map((record) => <WorkspaceRow key={record.content.id} record={record} recoveryMode={recoveryMode} onRefresh={refresh} />) : <div className="empty-state"><div className="empty-icon">□</div><h2>{query ? '没有找到工作区' : filter === 'archived' ? '没有已归档的工作区' : '还没有保存窗口'}</h2><p>{query ? '试试其他名称。' : filter === 'archived' ? '归档的工作区会显示在这里。' : '点击浏览器工具栏中的 WindowStash 开始保存。'}</p></div>}
        </section>
      </main>
      {manualSyncState === 'success' ? <SuccessToast message="已同步到云端" onDismiss={() => setManualSyncState('idle')} /> : null}
      {accountOpen && <AccountDialog session={session} onClose={() => setAccountOpen(false)} onChanged={authChanged} />}
      {diagnosticsOpen && <DiagnosticsDialog logs={logs} onClose={() => setDiagnosticsOpen(false)} onClear={async () => { await syncLogRepository.clear(); await refresh(); }} />}
      {connectionOpen && <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setConnectionOpen(false)}><SupabaseConfigForm initialConfig={config} onCancel={() => setConnectionOpen(false)} onSaved={onConfigChanged} /></div>}
    </div>
  );
}

export function OptionsRoot() {
  const [config, setConfig] = React.useState<SupabaseConfig | null | undefined>(undefined);
  const [openLogin, setOpenLogin] = React.useState(() => new URLSearchParams(window.location.search).get('login') === '1');
  const recoveryMode = new URLSearchParams(window.location.search).get('recover') === '1';
  React.useEffect(() => { void getSupabaseConfig().then(setConfig); }, []);
  if (config === undefined) return <main className="config-page">WindowStash</main>;
  if (!config) return <main className="config-page"><SupabaseConfigForm setup onSaved={(next) => { setOpenLogin(true); setConfig(next); }} /></main>;
  return <Dashboard key={`${config.url}\n${config.publishableKey}`} config={config} initialAccountOpen={openLogin} recoveryMode={recoveryMode} onConfigChanged={(next) => { setOpenLogin(true); setConfig(next); }} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><OptionsRoot /></React.StrictMode>);
