import React from 'react';
import type { Session } from '@supabase/supabase-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { cache, sortByRecent } from './lib/cache';
import { chromeBridge } from './lib/chromeBridge';
import { ChevronIcon, LogoMark, SearchIcon, WorkspaceIcon } from './lib/icons';
import {
  CONNECTION_FAILED,
  getDevelopmentSupabaseConfig,
  getSupabaseClient,
  getSupabaseConfig,
  normalizeSupabaseConfig,
  saveSupabaseConfig,
  testSupabaseConnection,
  verifyWorkspaceSchema,
} from './lib/supabase';
import { workspaceService } from './features/workspaces';
import type { SupabaseConfig, View, WorkspaceSummary } from './types';

const REFRESH_INTERVAL = 7 * 60 * 1000;

function SupabaseConfigPanel({ config, setup, onSaved, onCancel }: {
  config?: SupabaseConfig | null;
  setup?: boolean;
  onSaved: (config: SupabaseConfig) => void;
  onCancel?: () => void;
}) {
  const developmentDefault = getDevelopmentSupabaseConfig();
  const [url, setUrl] = React.useState(config?.url ?? developmentDefault?.url ?? '');
  const [publishableKey, setPublishableKey] = React.useState(config?.publishableKey ?? developmentDefault?.publishableKey ?? '');
  const [message, setMessage] = React.useState('');
  const [tested, setTested] = React.useState('');
  const [busy, setBusy] = React.useState<'test' | 'save' | null>(null);
  const signature = `${url.trim()}\n${publishableKey.trim()}`;

  const update = (setter: (value: string) => void, value: string) => {
    setter(value);
    setMessage('');
    setTested('');
  };

  async function test() {
    try {
      normalizeSupabaseConfig({ url, publishableKey });
    } catch {
      setMessage(CONNECTION_FAILED);
      return;
    }
    setBusy('test');
    setMessage('');
    const connected = await testSupabaseConnection({ url, publishableKey });
    setBusy(null);
    setTested(connected ? signature : '');
    setMessage(connected ? '✓ 连接成功' : CONNECTION_FAILED);
  }

  async function save() {
    if (tested !== signature) return setMessage('请先测试连接');
    setBusy('save');
    try {
      onSaved(await saveSupabaseConfig({ url, publishableKey }));
    } catch {
      setMessage(CONNECTION_FAILED);
      setTested('');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="config-shell">
      <header className="page-header">{onCancel ? <button className="back-button" onClick={onCancel} aria-label="返回">‹</button> : <span />}<h1>{setup ? '连接 Supabase' : '连接设置'}</h1><span /></header>
      <section className="supabase-form">
        {setup ? <div className="config-brand"><LogoMark /><strong>WindowStash</strong></div> : null}
        <p>WindowStash 使用你自己的 Supabase 项目保存 Workspace。</p>
        {!setup ? <aside>更换 Supabase 项目后，将切换到另一套 Workspace 数据。旧项目里的数据不会被删除。</aside> : null}
        <label><span>Project URL</span><input type="url" value={url} onChange={(event) => update(setUrl, event.target.value)} placeholder="https://your-project.supabase.co" autoFocus /></label>
        <label><span>Publishable Key</span><input value={publishableKey} onChange={(event) => update(setPublishableKey, event.target.value)} autoComplete="off" spellCheck={false} /></label>
        {message ? <small className={tested === signature ? 'success' : ''} role="status">{message}</small> : null}
        <div className="config-buttons"><button disabled={busy !== null} onClick={() => void test()}>{busy === 'test' ? '正在测试…' : '测试连接'}</button><button className="primary-button" disabled={busy !== null || tested !== signature} onClick={() => void save()}>{busy === 'save' ? '正在保存…' : setup ? '保存并继续' : '保存'}</button></div>
        {developmentDefault ? <button className="restore-button" onClick={() => { setUrl(developmentDefault.url); setPublishableKey(developmentDefault.publishableKey); setMessage(''); setTested(''); }}>恢复默认</button> : null}
      </section>
    </main>
  );
}

function Login({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseClient();
    if (!supabase) return setError('请先连接 Supabase');
    setBusy(true);
    setError('');
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (signInError || !data.session) return setError('邮箱或密码不正确');
    try {
      await verifyWorkspaceSchema(supabase);
    } catch (caught) {
      return setError(caught instanceof Error ? caught.message : '暂时无法读取 WindowStash 数据库');
    }
    onSignedIn(data.session);
  }

  return (
    <main className="auth-shell">
      <header className="brand"><LogoMark /><span>WindowStash</span></header>
      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <h1>登录</h1>
        <label><span>邮箱</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus required /></label>
        <label><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-button" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>
    </main>
  );
}

function ExtensionConnect({ onConnected }: { onConnected: (id: string) => void }) {
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState('');

  function connect(event: React.FormEvent) {
    event.preventDefault();
    try {
      chromeBridge.connect(value);
      onConnected(value.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法连接 Chrome 扩展');
    }
  }

  return (
    <form className="connection-panel" onSubmit={connect}>
      <strong>连接 Chrome 扩展</strong>
      <p>自动识别失败，请粘贴 WindowStash 的扩展 ID。</p>
      <div><input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Chrome 扩展 ID" /><button>连接</button></div>
      {error ? <small role="alert">{error}</small> : null}
    </form>
  );
}

function Settings({ config, extensionId, onBack, onConfigChange, onExtensionChange, onSignOut }: {
  config: SupabaseConfig;
  extensionId: string | null;
  onBack: () => void;
  onConfigChange: (config: SupabaseConfig) => void;
  onExtensionChange: (id: string | null) => void;
  onSignOut: () => void;
}) {
  const [autostart, setAutostart] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [connectionOpen, setConnectionOpen] = React.useState(false);

  React.useEffect(() => { void isEnabled().then(setAutostart).catch(() => setAutostart(false)); }, []);

  async function toggleAutostart() {
    setBusy(true);
    try {
      if (autostart) await disable(); else await enable();
      setAutostart(!autostart);
    } finally {
      setBusy(false);
    }
  }

  if (connectionOpen) return <SupabaseConfigPanel config={config} onCancel={() => setConnectionOpen(false)} onSaved={onConfigChange} />;

  return (
    <main className="popover-shell">
      <header className="page-header"><button className="back-button" onClick={onBack} aria-label="返回">‹</button><h1>设置</h1><span /></header>
      <section className="settings-list">
        <button className="setting-row" disabled={busy} onClick={() => void toggleAutostart()}><span><b>开机启动 WindowStash</b><small>登录电脑后自动显示菜单栏图标</small></span><i className={autostart ? 'switch on' : 'switch'} aria-hidden="true" /></button>
        <button className="setting-row" onClick={() => setConnectionOpen(true)}><span><b>Supabase</b><small>连接设置</small></span><span className="row-chevron">›</span></button>
        <div className="setting-row static"><span><b>Chrome 扩展</b><small>{extensionId ? '已连接' : '未连接'}</small></span>{extensionId ? <button className="text-button" onClick={() => { chromeBridge.disconnect(); onExtensionChange(null); }}>重新连接</button> : null}</div>
        {!extensionId ? <ExtensionConnect onConnected={onExtensionChange} /> : null}
      </section>
      <footer className="settings-footer"><button onClick={onSignOut}>退出登录</button></footer>
    </main>
  );
}

function Launcher({ config, session, onConfigChange, onSignOut }: { config: SupabaseConfig; session: Session; onConfigChange: (config: SupabaseConfig) => void; onSignOut: () => void }) {
  const [view, setView] = React.useState<View>('launcher');
  const [items, setItems] = React.useState<WorkspaceSummary[]>(() => workspaceService.cached());
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(0);
  const [opening, setOpening] = React.useState('');
  const [failedId, setFailedId] = React.useState('');
  const [error, setError] = React.useState('');
  const [extensionId, setExtensionId] = React.useState<string | null>(() => cache.extensionId());
  const searchRef = React.useRef<HTMLInputElement>(null);

  const refresh = React.useCallback(async () => {
    try {
      setItems(await workspaceService.refresh());
      setError('');
    } catch (caught) {
      if (!cache.workspaces().length) setError(caught instanceof Error ? caught.message : '暂时无法刷新工作区');
    }
  }, []);

  React.useEffect(() => {
    void chromeBridge.extensionId().then(setExtensionId).catch(() => setExtensionId(null));
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL);
    const unlisten = listen('popover-opened', () => {
      setQuery('');
      setSelected(0);
      setOpening('');
      searchRef.current?.focus();
      void refresh();
    });
    searchRef.current?.focus();
    return () => { window.clearInterval(timer); void unlisten.then((stop) => stop()); };
  }, [refresh, session.user.id]);

  const filtered = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const sorted = sortByRecent(items);
    return normalized ? sorted.filter((item) => item.name.toLocaleLowerCase().includes(normalized)) : sorted;
  }, [items, query]);

  React.useEffect(() => setSelected((value) => Math.min(value, Math.max(0, filtered.length - 1))), [filtered.length]);

  async function openWorkspace(item: WorkspaceSummary) {
    if (opening) return;
    setOpening(item.id);
    setFailedId('');
    setError('');
    try {
      await chromeBridge.openWorkspace(item.id);
      cache.markOpened(item.id);
      setItems((current) => sortByRecent(current));
      setOpening('');
      await invoke('hide_popover');
    } catch {
      setError('无法打开工作区');
      setFailedId(item.id);
      setOpening('');
    }
  }

  function handleKeys(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(filtered.length - 1, value + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
    if (event.key === 'Enter' && filtered[selected]) { event.preventDefault(); void openWorkspace(filtered[selected]); }
    if (event.key === 'Escape') void invoke('hide_popover');
  }

  if (view === 'settings') return <Settings config={config} extensionId={extensionId} onBack={() => setView('launcher')} onConfigChange={onConfigChange} onExtensionChange={setExtensionId} onSignOut={onSignOut} />;

  return (
    <main className="popover-shell" onKeyDown={handleKeys}>
      <header className="launcher-header">
        <div className="brand"><LogoMark /><span>WindowStash</span></div>
        <label className="search-field"><SearchIcon /><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} placeholder="搜索工作区..." aria-label="搜索工作区" /></label>
      </header>
      <section className="workspace-section">
        <div className="section-title"><h1>{query ? '搜索结果' : '最近使用'}</h1><span>{filtered.length}</span></div>
        {!extensionId ? <ExtensionConnect onConnected={setExtensionId} /> : null}
        {error ? <div className="inline-error" role="alert"><span>{error}</span><button onClick={() => { const failed = items.find((item) => item.id === failedId); if (failed) void openWorkspace(failed); else void refresh(); }}>{failedId ? '重试' : '刷新'}</button></div> : null}
        <div className="workspace-list" role="listbox" aria-label="工作区">
          {filtered.map((item, index) => (
            <button key={item.id} className={selected === index ? 'workspace-row selected' : 'workspace-row'} role="option" aria-selected={selected === index} onMouseEnter={() => setSelected(index)} onClick={() => void openWorkspace(item)}>
              <WorkspaceIcon />
              <span><b>{item.name}</b><small>{item.tabCount} 个标签页</small></span>
              {opening === item.id ? <em>正在打开…</em> : <ChevronIcon />}
            </button>
          ))}
          {!filtered.length && !error ? <p className="empty-state">{query ? '没有匹配的工作区' : '还没有可打开的工作区'}</p> : null}
        </div>
      </section>
      <footer className="utility-bar">
        <button onClick={() => void chromeBridge.openManager().catch(() => setError('无法打开管理器'))}>打开管理器</button>
        <button onClick={() => setView('settings')}>设置</button>
        <button onClick={() => void invoke('quit_app')}>退出</button>
      </footer>
    </main>
  );
}

export default function App() {
  const [config, setConfig] = React.useState<SupabaseConfig | null | undefined>(undefined);
  const [session, setSession] = React.useState<Session | null | undefined>(undefined);

  React.useEffect(() => {
    const next = getSupabaseConfig();
    setConfig(next);
    if (!next) void invoke('show_popover');
  }, []);

  React.useEffect(() => {
    if (!config) return;
    const supabase = getSupabaseClient();
    if (!supabase) return;
    setSession(undefined);
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) void invoke('show_popover');
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, [config]);

  async function signOut() {
    const supabase = getSupabaseClient();
    await supabase?.auth.signOut();
    setSession(null);
  }

  if (config === null) return <SupabaseConfigPanel setup onSaved={setConfig} />;
  if (config === undefined) return <main className="loading-shell"><LogoMark /><span>WindowStash</span></main>;
  if (session === undefined) return <main className="loading-shell"><LogoMark /><span>WindowStash</span></main>;
  if (!session) return <Login onSignedIn={setSession} />;
  return <Launcher config={config} session={session} onConfigChange={setConfig} onSignOut={() => void signOut()} />;
}
