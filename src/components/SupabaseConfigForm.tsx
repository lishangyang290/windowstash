import React from 'react';
import { ConfigurationSteps } from './ConfigurationSteps';
import { ConfigurationModes } from './ConfigurationModes';
import { FlowFooter } from './FlowFooter';
import { SuccessToast } from './SuccessToast';
import { browser } from 'wxt/browser';
import projectSettings from '../../supabase/setup-guide.json';
import schema from '../../supabase/schema.sql?raw';
import { VisibilityToggleInput } from '@/components/VisibilityToggleInput';
import {
  CONNECTION_FAILED,
  getDevelopmentSupabaseConfig,
  normalizeSupabaseConfig,
  saveSupabaseConfig,
  testSupabaseConnection,
  type SupabaseConfig,
} from '@/lib/supabase/client';

const DRAFT_KEY = 'windowstash-supabase-draft:v1';

export function getSetupMode() {
  try { const mode = sessionStorage.getItem('windowstash-setup-mode'); return mode === 'quick' || mode === 'guided' ? mode : undefined; }
  catch { return undefined; }
}

function readDraft(scope: string, key = DRAFT_KEY) {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return draft?.scope === scope && typeof draft.url === 'string' && typeof draft.publishableKey === 'string'
      && ['quick', 'guided'].includes(draft.mode) && Number.isInteger(draft.step) && draft.step >= 0 && draft.step <= 2
      && (draft.completed === undefined || (Number.isInteger(draft.completed) && draft.completed >= 0 && draft.completed <= 2))
      ? draft as { url: string; publishableKey: string; mode: 'quick' | 'guided'; step: number; completed?: number; verified?: SupabaseConfig | null } : null;
  } catch { return null; }
}

export function SupabaseConfigForm({ initialConfig, setup, settings = false, authorization = false, initialStep, onSaved, onCancel, mode: sharedMode, onModeChange }: {
  initialConfig?: SupabaseConfig | null;
  setup?: boolean;
  settings?: boolean;
  initialStep?: number;
  authorization?: boolean;
  onSaved: (config: SupabaseConfig) => void;
  onCancel?: () => void;
  mode?: 'quick' | 'guided';
  onModeChange?: (mode: 'quick' | 'guided') => void;
}) {
  const scope = (settings ? 'settings:' : '') + (initialConfig ? `${initialConfig.url}\n${initialConfig.publishableKey}` : 'setup');
  const draftKey = settings ? `${DRAFT_KEY}:settings` : DRAFT_KEY;
  const [draft] = React.useState(() => readDraft(scope, draftKey));
  const developmentDefault = getDevelopmentSupabaseConfig();
  const [url, setUrl] = React.useState(draft?.url ?? initialConfig?.url ?? developmentDefault?.url ?? '');
  const [publishableKey, setPublishableKey] = React.useState(draft?.publishableKey ?? initialConfig?.publishableKey ?? developmentDefault?.publishableKey ?? '');
  const [verified, setVerified] = React.useState<SupabaseConfig | null>(() => draft && 'verified' in draft ? draft.verified ?? null : initialConfig ?? null);
  const isVerified = !!verified && verified.url === url && verified.publishableKey === publishableKey;
  const [message, setMessage] = React.useState('');
  const [localMode, setLocalMode] = React.useState<'quick' | 'guided'>(draft?.mode ?? getSetupMode() ?? (initialConfig ? 'quick' : 'guided'));
  const mode = sharedMode ?? localMode;
  const [completed, setCompleted] = React.useState(draft?.completed ?? initialStep ?? 0);
  const [fieldErrors, setFieldErrors] = React.useState<Partial<Record<'url' | 'key', string>>>({});
  const [step, setStep] = React.useState(initialStep ?? draft?.step ?? 0);
  const [copyMessage, setCopyMessage] = React.useState('');
  const [copySuccess, setCopySuccess] = React.useState(false);
  const [copyNotice, setCopyNotice] = React.useState(0);
  const [verificationNotice, setVerificationNotice] = React.useState(false);
  const id = React.useId();
  const [busy, setBusy] = React.useState<'test' | 'save' | null>(null);

  React.useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ scope, url, publishableKey, mode, step, completed, verified })); }
    catch { /* Configuration remains usable when session storage is unavailable. */ }
  }, [scope, draftKey, url, publishableKey, mode, step, completed, verified]);

  const update = (setter: (value: string) => void, value: string) => {
    setter(value);
    setVerified(null);
    setVerificationNotice(false);
    setMessage('');
    setFieldErrors({});
  };

  async function verifyConnection() {
    setVerificationNotice(false);
    setMessage('');
    setFieldErrors({});
    try {
      try { normalizeSupabaseConfig({ url, publishableKey }); }
      catch (error) {
        const text = error instanceof Error ? error.message : CONNECTION_FAILED;
        setFieldErrors(/URL/.test(text) ? { url: text } : { key: text });
        return;
      }
      setBusy('test');
      if (!await testSupabaseConnection({ url, publishableKey })) {
        setFieldErrors({ url: '请核对项目地址。', key: '请重新复制同一项目的公开密钥。' });
        throw new Error(CONNECTION_FAILED);
      }
      setVerified({ url, publishableKey });
      setVerificationNotice(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : CONNECTION_FAILED);
    } finally {
      setBusy(null);
    }
  }

  async function continueToLogin() {
    if (!isVerified || busy) return;
    setBusy('save');
    setMessage('');
    try {
      const config = await saveSupabaseConfig({ url, publishableKey }, verified!);
      try { if (!settings) sessionStorage.setItem('windowstash-setup-mode', mode); sessionStorage.removeItem(draftKey); } catch { /* Storage may be unavailable. */ }
      onSaved(config);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : CONNECTION_FAILED);
    } finally { setBusy(null); }
  }

  async function copySchema() {
    try {
      await navigator.clipboard.writeText(schema);
      setCopyMessage('初始化代码已复制，回到 SQL Editor 粘贴并运行。');
      setCopySuccess(true);
      setCopyNotice((value) => value + 1);
    } catch {
      setCopySuccess(false);
      setCopyMessage('无法复制，请直接选择下方代码并手动复制。');
    }
  }

  function next() {
    setMessage('');
    setCompleted(Math.max(completed, step + 1));
    setStep(step + 1);
  }

  const guided = !settings && mode === 'guided';
  const showFields = !guided || step >= 2;

  const fields = [
    { name: 'Project URL', field: 'url', title: '获取 Project URL', help: '在 Project Overview → Copy → Project URL 中复制。' },
    { name: 'Publishable Key', field: 'key', title: '获取 Publishable Key', help: '在 Project Overview → Copy → Publishable key 中复制。' },
  ];

  return (
    <section className={`supabase-config${setup ? ' setup' : ''} ${guided ? 'guided' : 'quick'}${settings ? ' config-settings' : ''}`} aria-label="Supabase 配置">
      {verificationNotice ? <SuccessToast message="Supabase 验证成功" onDismiss={() => setVerificationNotice(false)} /> : null}
      {copyMessage && copySuccess ? <SuccessToast key={copyNotice} message={copyMessage} onDismiss={() => setCopyMessage('')} /> : null}
      {onCancel && !setup ? <button className="config-close" disabled={busy !== null} onClick={onCancel} aria-label="关闭 Supabase 设置">×</button> : null}
      {settings ? <header className="config-heading"><h2>数据存储</h2><p>修改 Supabase 配置。更换项目后将切换 Workspace 数据，原项目的数据和未同步记录会保留。</p></header> : null}
      {!settings && (!setup || authorization) ? <header className="config-heading">
        {!setup ? <div className="config-title-row"><a className="config-full-guide" href={browser.runtime.getURL('/开始使用.html')} target="_blank" rel="noopener noreferrer">查看完整教程 ↗</a></div> : null}
        {authorization ? <p>完成配置后，继续当前 Companion 登录。</p> : null}
      </header> : null}
      {!settings ? <><ConfigurationModes mode={mode} busy={busy !== null} onChange={(next) => { if (onModeChange) onModeChange(next); else setLocalMode(next); }} />
      <ConfigurationSteps quick={!guided} step={guided ? step : 2} completed={completed} canLogin={isVerified} busy={busy !== null} onSelect={(index) => { if (index === 3) void continueToLogin(); else { setStep(index); setMessage(''); } }} /></> : null}
      {guided ? <>
        <article className="config-guide" aria-labelledby={`${id}-step`}>
          <div className={step === 2 ? 'config-connection-heading' : undefined}>
            <div><h3 id={`${id}-step`}>{['创建 Supabase 项目', '初始化数据库', '连接 Supabase'][step]}</h3>
              {step === 2 ? <p>从同一个 Supabase 项目获取以下两项信息，然后验证并保存。</p> : null}
            </div>
            {step === 2 ? <a className="button config-external" href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">打开 Supabase ↗</a> : null}
          </div>
          {step === 0 ? <>
            <p>为 WindowStash 创建一个用于保存工作区的数据库，只需设置一次。</p>
            <div className="config-task-action"><p>登录 Supabase，点击 <strong>New project</strong>，项目名称填写 <strong>WindowStash</strong>。</p><a className="button config-external" href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">打开 Supabase ↗</a></div>
            <div className="config-help"><h4>创建项目时，各项怎么填写？</h4>
              <p>生成 Database password 并保存到密码管理器。它用于管理数据库，与之后的 WindowStash 登录密码不同。</p>
              <table className="config-security"><tbody>{projectSettings.map(([name, value]) => <tr key={name}><th scope="row">{name}</th><td>{value}</td></tr>)}</tbody></table>
            </div>
            <p className="config-step-note">点击 Create new project，等待项目后台准备好，再进入下一步。</p>
          </> : step === 1 ? <>
            <p>为新创建的空数据库建立工作区数据表和用户数据保护规则。</p>
            <div className="config-task-action"><div><h4>复制代码，在 SQL Editor 运行</h4><p>新建查询，完整粘贴代码，然后点击 <strong>Run</strong>。</p></div><div className="config-sql-actions"><button className="button" onClick={() => void copySchema()}>复制初始化 SQL</button><a className="config-external" href="https://supabase.com/dashboard/project/_/sql/new" target="_blank" rel="noopener noreferrer">打开 SQL Editor ↗</a></div></div>
            {copyMessage && !copySuccess ? <p className="config-copy-feedback" role="alert">{copyMessage}</p> : null}
            <div className="config-code"><pre><code>{schema}</code></pre></div>
            <p className="config-step-note">看到执行成功且没有错误后继续。复制代码不代表数据库已初始化。</p>
          </> : null}
        </article>
      </> : null}
      {showFields ? <div className="config-fields">
        {fields.map((field, index) => <section className="config-field-task" key={field.field} aria-labelledby={`${id}-${field.field}-task`}>
          <div className="config-task-heading config-field-heading">
            <h4 id={`${id}-${field.field}-task`}>{settings ? field.name : `${index + 1}. ${field.title}`}</h4>
            <p className="config-field-help">{field.help}</p>
          </div>
          <label className="sr-only" id={`${id}-${field.field}-label`} htmlFor={`${id}-${field.field}`}>{field.name}</label>
          {field.field === 'url' ? <input id={`${id}-url`} type="url" value={url} disabled={busy !== null} aria-invalid={!!fieldErrors.url} aria-describedby={fieldErrors.url ? `${id}-url-error` : undefined} onChange={(event) => update(setUrl, event.target.value)} placeholder="https://your-project.supabase.co" autoFocus={setup && !guided} spellCheck={false} autoComplete="off" />
            : <VisibilityToggleInput id={`${id}-key`} value={publishableKey} disabled={busy !== null} aria-invalid={!!fieldErrors.key} aria-describedby={fieldErrors.key ? `${id}-key-error` : undefined} onChange={(value) => update(setPublishableKey, value)} showLabel="显示 Publishable Key" hideLabel="隐藏 Publishable Key" placeholder="sb_publishable_…" spellCheck={false} autoComplete="off" />}
          {fieldErrors[field.field as 'url' | 'key'] ? <p className="config-field-error" id={`${id}-${field.field}-error`} role="alert">{fieldErrors[field.field as 'url' | 'key']}</p> : null}
        </section>)}
        <div className="config-connection-check">
          {busy === 'test' ? <p className="config-feedback" role="status">正在验证项目连接，请允许 Chrome 访问此项目。</p> : null}
          <button className={`button config-verify-button${isVerified ? ' config-verify-success' : ''}`} disabled={busy !== null || isVerified} aria-busy={busy === 'test'} onClick={() => void verifyConnection()}>{busy === 'test' ? '正在验证…' : isVerified ? '验证成功' : '验证连接'}</button>
        </div>
      </div> : null}
      <FlowFooter inline={settings}>
        {message ? <p className="config-message" role="alert">{message}</p> : null}
        {busy === 'save' ? <p className="config-feedback" role="status">正在保存配置…</p> : null}
        <div className="config-footer-row">
          {showFields && !busy ? <p className={isVerified ? 'config-verify-feedback' : 'config-footer-hint'} role={isVerified ? 'status' : undefined}>{isVerified ? (settings ? '连接验证成功，可以保存。' : '连接验证成功，可以继续。') : settings ? '修改配置后请重新验证连接。' : '验证成功后继续注册或登录。连接验证不代替数据库初始化。'}</p> : null}
        <div className="config-footer-actions">
          {guided && step > 0 ? <button className="button" disabled={busy !== null} onClick={() => { setStep(step - 1); setMessage(''); }}>上一步</button> : null}
          {guided && step < 2 ? <button className="button button-primary" onClick={next}>{['项目已创建，下一步', '已运行 SQL，下一步'][step]}</button> : <button className="button button-primary" disabled={busy !== null || !isVerified} aria-busy={busy === 'save'} onClick={() => void continueToLogin()}>{busy === 'save' ? '正在保存…' : settings ? '保存配置' : '下一步'}</button>}
        </div>
        </div>
      </FlowFooter>
      {developmentDefault ? <div className="config-secondary">
        <button disabled={busy !== null} onClick={() => { setUrl(developmentDefault.url); setPublishableKey(developmentDefault.publishableKey); setVerified(null); setMessage(''); }}>恢复默认</button>
      </div> : null}
    </section>
  );
}
