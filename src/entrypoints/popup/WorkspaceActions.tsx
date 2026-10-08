export function WorkspaceActions({ action, phase, blocked, reopeningWorkspace, showReopen, onSave, onReopen }: {
  action: 'save' | 'close' | null;
  phase: 'idle' | 'saving';
  blocked: boolean;
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
    <div className="popup-actions">
      <button className="button button-primary" disabled={blocked || busy} onClick={() => onSave(false)}>{label('save', '保存当前状态')}</button>
      <button className="button" disabled={blocked || busy} onClick={() => onSave(true)}>{label('close', '保存并关闭窗口')}</button>
      {showReopen ? <button className="button button-quiet reopen-workspace" disabled={blocked || busy} onClick={onReopen}>{reopeningWorkspace ? '正在重新打开…' : '重新打开工作区'}</button> : null}
    </div>
  );
}
