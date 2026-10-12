import React from 'react';
import { checkCompanion } from '@/lib/companion/connection';
import { SuccessToast } from './SuccessToast';

export function CompanionStatus() {
  const [message, setMessage] = React.useState('正在检测 Companion…');
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [checkedAt, setCheckedAt] = React.useState('');
  const [completion, setCompletion] = React.useState(0);
  const running = React.useRef(false);
  const completionId = React.useRef(0);
  const check = React.useCallback(async (manual = false) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setCompletion(0);
    try {
      const result = await checkCompanion(new URLSearchParams(window.location.search).get('companionRoute'));
      setMessage(result.companionRunning ? 'Companion 通信正常。' : '本机组件通信正常；Companion 当前未运行。');
      setFailed(false);
      setCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      if (manual) setCompletion(++completionId.current);
    } catch (caught) {
      setFailed(true);
      setMessage(caught instanceof Error ? caught.message : '无法连接 Companion，请重试');
      setCheckedAt('');
    } finally { running.current = false; setBusy(false); }
  }, []);
  React.useEffect(() => {
    void check();
    const timer = window.setInterval(() => void check(), 15_000);
    return () => window.clearInterval(timer);
  }, [check]);
  return <>
    <div className="quiet-notice" aria-busy={busy}>
      <p role={failed ? 'alert' : 'status'}>{message}{checkedAt ? <small> · 最近检测 {checkedAt}</small> : null}</p>
      <button className="notice-button" disabled={busy} onClick={() => void check(true)}>{busy ? '检测中…' : '重新检测'}</button>
    </div>
    {completion ? <SuccessToast key={completion} message="检测完成" onDismiss={() => setCompletion(0)} /> : null}
  </>;
}
