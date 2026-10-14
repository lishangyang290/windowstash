import React from 'react';
import { listen } from '@tauri-apps/api/event';
import { chromeBridge, type ChromeConnection } from './lib/chromeBridge';

const profileName = (profile: string) => profile === 'Default' ? '默认浏览器' : profile.replace(/^Profile /, 'Chrome 用户 ');

export function ChromeConnectionPanel({ compact = false, onManage }: { compact?: boolean; onManage?: () => void }) {
  const [connection, setConnection] = React.useState<ChromeConnection | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const running = React.useRef(false);
  const refresh = React.useCallback(async () => {
    if (running.current) return;
    running.current = true; setBusy(true);
    try { setConnection(await chromeBridge.connection()); setError(''); }
    catch (caught) { setConnection(null); setError(String(caught)); }
    finally { running.current = false; setBusy(false); }
  }, []);
  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    const stop = listen('popover-opened', () => void refresh());
    return () => { window.clearInterval(timer); void stop.then((unlisten) => unlisten()); };
  }, [refresh]);
  async function select(value: string) {
    const target = connection?.targets[Number(value)];
    if (!target || running.current) return;
    running.current = true;
    setBusy(true); setSaved(false);
    try { setConnection(await chromeBridge.select(target)); setError(''); setSaved(true); }
    catch (caught) { setError(String(caught)); }
    finally { running.current = false; setBusy(false); }
  }
  if (compact) {
    if (connection?.selected || (!connection && !error)) return null;
    return <div className="chrome-attention"><span>{connection?.targets.length ? '选择用于打开工作区的浏览器' : '暂时无法找到 Chrome 扩展'}</span><button onClick={onManage}>设置</button></div>;
  }
  const index = connection?.targets.findIndex((target) => target.profile === connection.selected?.target.profile && target.extension_id === connection.selected.target.extension_id) ?? -1;
  return <section className="chrome-preferences">
    <div className="chrome-target">
      <h2>打开工作区的浏览器</h2>
      <p>选择会保留，下次打开工作区时继续使用。</p>
      {connection?.targets.length ? <label>Chrome 用户<select aria-label="Chrome 用户" disabled={busy} value={index < 0 ? '' : String(index)} onChange={(event) => void select(event.target.value)}>
        <option value="" disabled>请选择浏览器</option>
        {connection.targets.map((target, i) => <option key={`${target.profile}:${target.extension_id}`} value={i}>{profileName(target.profile)}{connection.targets.filter((item) => item.profile === target.profile).length > 1 ? ` · 实例 ${i + 1}` : ''}</option>)}
      </select></label> : <p>{connection ? '请先在 Chrome 中安装并启用 WindowStash。' : error ? '无法识别浏览器，请重试。' : '正在识别浏览器…'}</p>}
      {saved ? <p role="status">已保存浏览器选择</p> : null}
      {(error || connection?.host_error || connection?.error) && <p className="chrome-error" role="alert">{error || connection?.host_error || connection?.error}</p>}
      <button className="text-button" disabled={busy} onClick={() => void refresh()}>重新识别浏览器</button>
    </div>
  </section>;
}

export function ChromeConnectionPage({ onBack }: { onBack: () => void }) {
  return <main className="popover-shell chrome-settings-shell">
    <header className="page-header"><button className="back-button" onClick={onBack} aria-label="返回">‹</button><h1>切换 Chrome 用户</h1><span /></header>
    <section className="settings-list"><ChromeConnectionPanel /></section>
  </main>;
}
