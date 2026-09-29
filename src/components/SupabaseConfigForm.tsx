import React from 'react';
import {
  CONNECTION_FAILED,
  getDevelopmentSupabaseConfig,
  normalizeSupabaseConfig,
  saveSupabaseConfig,
  testSupabaseConnection,
  type SupabaseConfig,
} from '@/lib/supabase/client';

export function SupabaseConfigForm({ initialConfig, setup, onSaved, onCancel }: {
  initialConfig?: SupabaseConfig | null;
  setup?: boolean;
  onSaved: (config: SupabaseConfig) => void;
  onCancel?: () => void;
}) {
  const developmentDefault = getDevelopmentSupabaseConfig();
  const [url, setUrl] = React.useState(initialConfig?.url ?? developmentDefault?.url ?? '');
  const [publishableKey, setPublishableKey] = React.useState(initialConfig?.publishableKey ?? developmentDefault?.publishableKey ?? '');
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
    setMessage('');
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
    <section className={`supabase-config${setup ? ' setup' : ''}`}>
      <div className="config-heading">
        {setup ? <><h1>WindowStash</h1><h2>连接你的数据存储</h2></> : <><p>数据存储</p><h2>Supabase</h2></>}
        <span>WindowStash 使用你自己的 Supabase 项目保存 Workspace。</span>
      </div>
      {!setup ? <p className="config-warning">更换 Supabase 项目后，将切换到另一套 Workspace 数据。旧项目里的数据不会被删除。</p> : null}
      <label><span>Supabase Project URL</span><input type="url" value={url} onChange={(event) => update(setUrl, event.target.value)} placeholder="https://your-project.supabase.co" autoFocus={setup} /></label>
      <label><span>Publishable Key</span><input value={publishableKey} onChange={(event) => update(setPublishableKey, event.target.value)} spellCheck={false} autoComplete="off" /></label>
      {message ? <p className={tested === signature ? 'config-message success' : 'config-message'} role="status">{message}</p> : null}
      <div className="config-actions">
        <button className="button" disabled={busy !== null} onClick={() => void test()}>{busy === 'test' ? '正在测试…' : '测试连接'}</button>
        <button className="button button-primary" disabled={busy !== null || tested !== signature} onClick={() => void save()}>{busy === 'save' ? '正在保存…' : setup ? '保存并继续' : '保存'}</button>
      </div>
      <button className="config-tutorial" onClick={() => window.open('/开始使用.html', '_blank', 'noopener,noreferrer')}>查看开始使用教程 <span>↗</span></button>
      <div className="config-secondary">
        {developmentDefault ? <button onClick={() => { setUrl(developmentDefault.url); setPublishableKey(developmentDefault.publishableKey); setTested(''); setMessage(''); }}>恢复默认</button> : null}
        {onCancel ? <button onClick={onCancel}>取消</button> : null}
      </div>
    </section>
  );
}
