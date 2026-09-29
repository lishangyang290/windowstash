import React from 'react';
import type { Session } from '@supabase/supabase-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { cache, sortByRecent } from './lib/cache';
import { chromeBridge } from './lib/chromeBridge';
import { ChevronIcon, LogoMark, SearchIcon, WorkspaceIcon } from './lib/icons';
import { supabase } from './lib/supabase';
import { workspaceService } from './features/workspaces';
import type { View, WorkspaceSummary } from './types';

const REFRESH_INTERVAL = 7 * 60 * 1000;

function Login({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase) return setError('请先配置 Companion 的 Supabase 环境变量');
    setBusy(true);
    setError('');
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (signInError || !data.session) return setError('邮箱或密码不正确');
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

function Settings({ extensionId, onBack, onExtensionChange, onSignOut }: {
  extensionId: string | null;
  onBack: () => void;
  onExtensionChange: (id: string | null) => void;
  onSignOut: () => void;
}) {
  const [autostart, setAutostart] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

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

  return (
    <main className="popover-shell">
      <header className="page-header"><button className="back-button" onClick={onBack} aria-label="返回">‹</button><h1>设置</h1><span /></header>
      <section className="settings-list">
        <button className="setting-row" disabled={busy} onClick={() => void toggleAutostart()}><span><b>开机启动 WindowStash</b><small>登录电脑后自动显示菜单栏图标</small></span><i className={autostart ? 'switch on' : 'switch'} aria-hidden="true" /></button>
        <div className="setting-row static"><span><b>Chrome 扩展</b><small>{extensionId ? '已连接' : '未连接'}</small></span>{extensionId ? <button className="text-button" onClick={() => { chromeBridge.disconnect(); onExtensionChange(null); }}>重新连接</button> : null}</div>
        {!extensionId ? <ExtensionConnect onConnected={onExtensionChange} /> : null}
      </section>
      <footer className="settings-footer"><button onClick={onSignOut}>退出登录</button></footer>
    </main>
  );
}

function Launcher({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
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
    } catch {
      if (!cache.workspaces().length) setError('暂时无法刷新工作区');
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

  if (view === 'settings') return <Settings extensionId={extensionId} onBack={() => setView('launcher')} onExtensionChange={setExtensionId} onSignOut={onSignOut} />;

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
  const [session, setSession] = React.useState<Session | null | undefined>(undefined);

  React.useEffect(() => {
    if (!supabase) {
      setSession(null);
      void invoke('show_popover');
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) void invoke('show_popover');
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase?.auth.signOut();
    setSession(null);
  }

  if (session === undefined) return <main className="loading-shell"><LogoMark /><span>WindowStash</span></main>;
  if (!session) return <Login onSignedIn={setSession} />;
  return <Launcher session={session} onSignOut={() => void signOut()} />;
}
