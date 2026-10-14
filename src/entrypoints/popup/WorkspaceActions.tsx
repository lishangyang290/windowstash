export function WorkspaceActions({ action, phase, saveBlocked, reopenBlocked, reopenLabel, reopeningWorkspace, showReopen, onSave, onReopen, variant = 'all' }: {
  variant?: 'all' | 'save' | 'reopen';
  action: 'save' | 'close' | null;
  phase: 'idle' | 'saving';
  saveBlocked: boolean;
  reopenBlocked: boolean;
  reopenLabel: string;
  reopeningWorkspace: boolean;
  showReopen: boolean;
  onSave: (closeAfterSave: boolean) => void;
  onReopen: () => void;
}) {
  const busy = phase !== 'idle' || reopeningWorkspace;
  const label = (buttonAction: 'save' | 'close', idleLabel: string) => (
    action === buttonAction && phase === 'saving' ? '正在保存…' : idleLabel
  );

  return (
    <div className={variant === 'reopen' ? 'workspace-reopen' : 'popup-actions'}>
      {variant !== 'reopen' && <>
        <button className="button button-primary" disabled={saveBlocked || busy} onClick={() => onSave(false)}>{label('save', '保存当前状态')}</button>
        <button className="button" disabled={saveBlocked || busy} onClick={() => onSave(true)}>{label('close', '保存并关闭窗口')}</button>
      </>}
      {showReopen && variant !== 'save' ? <button className="button button-quiet reopen-workspace" title={reopenLabel} aria-label={reopenLabel} disabled={reopenBlocked || busy} onClick={onReopen}>
        {variant === 'reopen' && <svg className="reopen-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7" /></svg>}
        {reopeningWorkspace ? reopenLabel === '重新打开工作区' ? '正在重新打开…' : '正在恢复…' : variant === 'reopen' && reopenLabel === '重新打开工作区' ? '重新打开' : reopenLabel}
      </button> : null}
    </div>
  );
}
