import React from 'react';

export function VisibilityToggleInput({
  value,
  onChange,
  showLabel = '显示密码',
  hideLabel = '隐藏密码',
  ...inputProps
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  showLabel?: string;
  hideLabel?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [visible, setVisible] = React.useState(false);
  const actionLabel = visible ? hideLabel : showLabel;

  function toggleVisibility() {
    const input = inputRef.current;
    const selection = input ? [input.selectionStart, input.selectionEnd] as const : null;
    setVisible((current) => !current);
    requestAnimationFrame(() => {
      if (!input || !selection || selection[0] === null || selection[1] === null || typeof input.setSelectionRange !== 'function') return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(selection[0], selection[1]);
    });
  }

  return (
    <div className="password-input-wrap">
      <input ref={inputRef} {...inputProps} type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} />
      <button className="password-visibility" type="button" onMouseDown={(event) => event.preventDefault()} onClick={toggleVisibility} aria-label={actionLabel} title={actionLabel} aria-pressed={visible} disabled={inputProps.disabled}>
        {visible ? (
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9 8 9 8a17.8 17.8 0 0 1-2.1 3.2M6.6 6.6C4.2 8.2 3 12 3 12s3.5 8 9 8a9.8 9.8 0 0 0 4.1-.9" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12s3.5-8 9-8 9 8 9 8-3.5 8-9 8-9-8-9-8Z" /><circle cx="12" cy="12" r="3" /></svg>
        )}
      </button>
    </div>
  );
}
