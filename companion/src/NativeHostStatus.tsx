import React from 'react';
import { listen } from '@tauri-apps/api/event';
import { chromeBridge } from './lib/chromeBridge';

export function NativeHostStatus({ children }: { children: React.ReactNode }) {
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const retry = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    let stopped = false, running = false;
    async function repair() {
      if (stopped || running) return;
      running = true; setBusy(true);
      try {
        const connection = await chromeBridge.connection();
        if (!stopped) setError(connection.host_error ?? '');
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        running = false;
        if (!stopped) setBusy(false);
      }
    }
    retry.current = repair;
    void repair();
    const stop = listen('popover-opened', () => void repair());
    const host = listen<string | null>('native-host-status', ({ payload }) => {
      if (!stopped) setError(payload ?? '');
    });
    return () => { stopped = true; void stop.then((unlisten) => unlisten()); void host.then((unlisten) => unlisten()); };
  }, []);
  return <div className="companion-root">
    {error && <div className="native-host-error" role="alert"><span>{error}。每 10 秒自动重试。</span><button disabled={busy} onClick={() => void retry.current()}>修复连接</button></div>}
    <div className="companion-content">{children}</div>
  </div>;
}
