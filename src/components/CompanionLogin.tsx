import React from 'react';
import type { Session } from '@supabase/supabase-js';
import { SetupFlow, useSetupNavigation } from './SetupFlow';
import { PageShell } from './PageShell';
import { authorizeCompanion, nativeAuth, NativeAuthError } from '@/lib/companion/auth';
import { authService } from '@/lib/supabase/authService';
import { getSupabaseConfig, resetMissingCompanionLink, type SupabaseConfig } from '@/lib/supabase/client';

export function CompanionLogin({ login }: { login: (refresh: () => Promise<void>, previous?: () => void, onBusyChange?: (busy: boolean) => void, showTitle?: boolean) => React.ReactNode }) {
  const navigation = useSetupNavigation();
  const params = new URLSearchParams(location.search);
  const request = params.get('companionLogin'), route = params.get('companionRoute');
  const valid = /^[a-f0-9]{64}$/.test(request ?? '') && /^[a-f0-9]{64}$/.test(route ?? '');
  const [config, setConfig] = React.useState<SupabaseConfig | null | undefined>();
  const [session, setSession] = React.useState<Session | null>(null);
  const [state, setState] = React.useState<'ready' | 'working' | 'done' | 'failed'>('ready');
  const [message, setMessage] = React.useState('');
  const [seconds, setSeconds] = React.useState(3);
  const [expired, setExpired] = React.useState(!valid);
  const [relogin, setRelogin] = React.useState(false);
  const [missingLink, setMissingLink] = React.useState(false);
  const busy = React.useRef(false);
  const mounted = React.useRef(true);
  const refresh = React.useCallback(async () => {
    try {
      const nextConfig = await getSupabaseConfig();
      const nextSession = nextConfig ? await authService.session() : null;
      if (mounted.current) { setConfig(nextConfig); setSession(nextSession); setRelogin(false); setMissingLink(false); setState('ready'); setMessage(''); }
    } catch (error) {
      if (mounted.current) { setMissingLink(error instanceof NativeAuthError && error.code === 'not_linked'); setState('failed'); setMessage(error instanceof Error ? error.message : '无法读取浏览器登录，请重试'); }
    }
  }, []);
  async function restartLogin() {
    if (busy.current) return;
    busy.current = true;
    try { await resetMissingCompanionLink(); await refresh(); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : '无法重新登录，请重试'); }
    finally { busy.current = false; }
  }
  React.useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);
  React.useEffect(() => {
    if (state !== 'done') return;
    const deadline = Date.now() + 3000;
    const countdown = window.setInterval(() => setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))), 1000);
    const redirect = window.setTimeout(() => window.location.replace('/options.html'), 3000);
    return () => { window.clearInterval(countdown); window.clearTimeout(redirect); };
  }, [state]);
  async function confirm() {
    if (busy.current || !valid) return;
    busy.current = true; setState('working'); setMessage('正在确认登录…');
    try {
      const next = await authService.session();
      if (!config || !next) { await refresh(); throw new Error('请先完成浏览器登录'); }
      await authorizeCompanion(config, next, request!, route!);
      setMessage('正在等待 Companion 加载工作区…');
      const deadline = Date.now() + 45000;
      while (mounted.current && Date.now() < deadline) {
        const result = await nativeAuth('completion', { login_request: request });
        if (result.completed) { setState('done'); setMessage('Companion 已登录，并已成功读取工作区。现在可以返回桌面使用。'); return; }
        if (result.failure) throw new Error('Companion 暂时无法读取工作区，请检查网络及数据库配置后重试');
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      throw new Error('尚未收到 Companion 的确认。请确保 Companion 正在运行，然后重试');
    } catch (error) {
      if (!mounted.current) return;
      const text = error instanceof Error ? error.message : '授权失败，请重试';
      setExpired(/请求已|关联已失效/.test(text)); setState('failed'); setMessage(text);
    } finally { busy.current = false; }
  }
  if (valid && !expired && config !== undefined && (!config || !session || relogin || navigation.editing)) {
    return <SetupFlow config={config} navigation={navigation} authorization login={(previous, onBusyChange, showTitle) => login(refresh, previous, onBusyChange, showTitle)} onSaved={refresh} message={message} />;
  }
  return <PageShell><div className="authorization-shell"><div className="authorization-content">
    <section className="authorization-task" aria-label="Companion 登录">
    {!valid || expired ? <><div className="authorization-heading"><h1>重新开始登录</h1><p>此次登录请求已失效。</p></div><p className="authorization-feedback">请返回 Companion，重新点击「在浏览器中登录」。</p></>
    : config === undefined ? <><div className="authorization-heading"><h1>准备登录</h1><p>正在读取浏览器中的登录状态…</p></div>{message && <p className="authorization-feedback" role="alert">{message}</p>}{state === 'failed' && <button className="button" onClick={() => void (missingLink ? restartLogin() : refresh())}>{missingLink ? '重新登录' : '重试'}</button>}</>
    : <>
      <div className="authorization-heading">
        {state === 'done' && <svg className="authorization-check" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" /><path d="m10 16 4 4 8-8" /></svg>}
        <h1>{state === 'done' ? '已登录 Companion' : '继续登录 Companion'}</h1>
        <p>{state === 'done' ? '工作区已就绪，可以返回桌面端。' : '确认使用当前 WindowStash 账号。'}</p>
      </div>
      <div className="authorization-account"><span className="authorization-avatar" aria-hidden="true">{session!.user.email?.[0]?.toUpperCase() ?? 'W'}</span><div><span>当前账号</span><p>{session!.user.email}</p></div></div>
      {message && <p className={state === 'done' ? 'authorization-complete' : 'authorization-feedback'} role={state === 'failed' ? 'alert' : 'status'}>{state === 'done' ? `登录已完成，${seconds} 秒后自动进入工作区管理器。` : message}</p>}
      {state !== 'done' && <button className="button button-primary authorization-action" aria-busy={state === 'working'} disabled={state === 'working'} onClick={() => void confirm()}>{state === 'working' ? '正在登录…' : state === 'failed' ? '重试' : '确认并返回 Companion'}</button>}
      {state === 'failed' && /登录已失效/.test(message) && <button className="button" onClick={() => setRelogin(true)}>重新登录</button>}
    </>}
    </section>
  </div></div></PageShell>;
}
