export function ConfigurationModes({ mode, busy = false, onChange }: {
  mode: 'quick' | 'guided'; busy?: boolean; onChange: (mode: 'quick' | 'guided') => void;
}) {
  return <div className="config-modes" role="group" aria-label="配置模式">
    <button disabled={busy} aria-pressed={mode === 'quick'} onClick={() => onChange('quick')}>快速配置</button>
    <button disabled={busy} aria-pressed={mode === 'guided'} onClick={() => onChange('guided')}>分步引导</button>
  </div>;
}
