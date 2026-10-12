import React from 'react';
import { ConfigurationModes } from './ConfigurationModes';
import { ConfigurationSteps } from './ConfigurationSteps';
import { PageShell } from './PageShell';
import { SupabaseConfigForm, getSetupMode } from './SupabaseConfigForm';
import type { SupabaseConfig } from '@/lib/supabase/client';

// Keep navigation in the current URL so refresh/back preserve Companion parameters.
export function useSetupNavigation() {
  const read = () => new URLSearchParams(window.location.search).get('view') === 'config';
  const [editing, setEditing] = React.useState(read);
  const readStep = () => { const value = Number(new URLSearchParams(window.location.search).get('setupStep') ?? 2); return [0, 1, 2].includes(value) ? value : 2; };
  const [step, setStep] = React.useState(readStep);
  React.useEffect(() => {
    const restore = () => { setEditing(read()); setStep(readStep()); };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const navigate = (config: boolean, index = 2) => {
    const url = new URL(window.location.href);
    if (config) { url.searchParams.set('view', 'config'); url.searchParams.set('setupStep', String(index)); }
    else { url.searchParams.delete('view'); url.searchParams.delete('setupStep'); }
    window.history[config ? 'pushState' : 'replaceState'](null, '', url);
    setStep(index);
    setEditing(config);
  };
  return { editing, step, navigate };
}

export function SetupFlow({ config, navigation, login, onSaved, authorization = false, message }: {
  config: SupabaseConfig | null;
  navigation: ReturnType<typeof useSetupNavigation>;
  login: (previous: () => void, onBusyChange: (busy: boolean) => void, showTitle: boolean) => React.ReactNode;
  onSaved: () => Promise<void>;
  authorization?: boolean;
  message?: string;
}) {
  const [mode, setMode] = React.useState<'quick' | 'guided'>(() => getSetupMode() ?? (config ? 'quick' : 'guided'));
  const [busy, setBusy] = React.useState(false);
  const changeMode = (next: 'quick' | 'guided') => { setMode(next); try { sessionStorage.setItem('windowstash-setup-mode', next); } catch { /* Keep navigation available. */ } };
  const configuring = !config || navigation.editing;
  return <PageShell>
    {configuring ? <SupabaseConfigForm setup authorization={authorization} initialConfig={config} initialStep={config ? navigation.step : undefined}
      mode={mode} onModeChange={changeMode}
      onSaved={() => { navigation.navigate(false); void onSaved(); }} />
      : <section className={`supabase-config setup flow-login ${mode}`} aria-label="注册 / 登录">
        <ConfigurationModes mode={mode} busy={busy} onChange={changeMode} />
        <ConfigurationSteps quick={mode === 'quick'} step={3} completed={3} busy={busy} onSelect={(step) => { if (step < 3) navigation.navigate(true, step); }} />
        {login(() => navigation.navigate(true), setBusy, mode === 'guided')}
        {message ? <p role="alert">{message}</p> : null}
      </section>}
  </PageShell>;
}
