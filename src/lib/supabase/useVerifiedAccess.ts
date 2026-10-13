import React from 'react';
import { browser } from 'wxt/browser';
import type { Session } from '@supabase/supabase-js';
import { authService } from './authService';
import { getSupabaseConfig, type SupabaseConfig } from './client';
import { measurePopupStage } from '@/lib/popupPerformance';

type Access = { config: SupabaseConfig | null; session: Session | null };

/** Retain verified UI during rechecks; identity-changing signals invalidate it immediately. */
export function useVerifiedAccess() {
  const [access, setAccess] = React.useState<Access>();
  const [checking, setChecking] = React.useState(true);
  const [message, setMessage] = React.useState('');
  const revision = React.useRef(0);
  const currentAccess = React.useRef(access);
  currentAccess.current = access;
  const pending = React.useRef<{ request: number; task: Promise<void> } | null>(null);
  const refresh = React.useCallback((clear = false): Promise<void> => {
    // Coalesce overlapping silent checks, but never join an identity invalidation.
    if (!clear && pending.current?.request === revision.current) return pending.current.task;
    const request = ++revision.current;
    if (clear) setAccess(undefined);
    setChecking(true);
    setMessage('');
    const task = (async () => {
      let config: SupabaseConfig | null = null;
      try {
        const { session, latest } = await measurePopupStage('identity', async () => {
          config = await getSupabaseConfig();
          const session = config ? await authService.session(config) : null;
          return { session, latest: await getSupabaseConfig() };
        });
        if (request !== revision.current) return;
        if (JSON.stringify(config) !== JSON.stringify(latest)) return void refresh(true);
        setAccess({ config, session });
      } catch (error) {
        if (request !== revision.current) return;
        setAccess({ config, session: null });
        setMessage(error instanceof Error ? error.message : '无法读取登录状态，请重试');
      } finally {
        if (request === revision.current) setChecking(false);
      }
    })().finally(() => { if (pending.current?.request === request) pending.current = null; });
    pending.current = { request, task };
    return task;
  }, []);
  const [connection, setConnection] = React.useState('');
  React.useEffect(() => {
    if (access) setConnection(access.config ? `${access.config.url}\n${access.config.publishableKey}` : '');
  }, [access]);
  React.useEffect(() => {
    void refresh();
    return () => { revision.current++; };
  }, [refresh]);
  React.useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const changed = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes).filter((key) => (key === 'supabaseConfig' || key === 'windowstash-data-owner:v1' || key.startsWith('windowstash-auth:') || key === 'windowstash-companion:auth-link:v1' || key === 'windowstash-companion:auth-revision') && JSON.stringify(changes[key]?.oldValue) !== JSON.stringify(changes[key]?.newValue));
      if (!keys.length) return;
      const identityChanged = keys.some((key) => {
        const { oldValue, newValue } = changes[key]!;
        if (!key.startsWith('windowstash-auth:')) return true;
        try {
          const previous = JSON.parse(String(oldValue)), next = JSON.parse(String(newValue));
          return !previous?.user?.id || previous.user.id !== next?.user?.id;
        } catch { return true; }
      });
      void refresh(identityChanged);
    };
    const recheck = () => void refresh();
    browser.storage.onChanged.addListener(changed);
    window.addEventListener('focus', recheck);
    window.addEventListener('pageshow', recheck);
    void authService.subscribe((_event, session) => {
      if (!active) return;
      const sameUser = session?.user.id && session.user.id === currentAccess.current?.session?.user.id;
      void refresh(!sameUser);
    }).then((stop) => { if (active) unsubscribe = stop; else stop(); }).catch(() => { if (active) void refresh(true); });
    return () => {
      active = false;
      unsubscribe?.();
      browser.storage.onChanged.removeListener(changed);
      window.removeEventListener('focus', recheck);
      window.removeEventListener('pageshow', recheck);
    };
  }, [connection, refresh]);
  return { access, checking, message, refresh };
}
