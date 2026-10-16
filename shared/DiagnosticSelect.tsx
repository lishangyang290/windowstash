import React, { useEffect, useId, useRef, useState } from 'react';

export function DiagnosticSelect({ label, value, options, onChange }: {
  label: string; value: string; options: [string, string][]; onChange: (value: string) => void;
}) {
  const id = useId(), wrapper = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const selected = Math.max(0, options.findIndex(([key]) => key === value));
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, id, open]);
  function choose(index: number) { onChange(options[index]![0]); setOpen(false); }
  function keyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); setOpen(true);
      setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : !open ? selected : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (open && ['Enter', ' '].includes(event.key)) { event.preventDefault(); choose(active); }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
    else if (event.key === 'Tab') setOpen(false);
  }
  return <div className="diag-select" ref={wrapper} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      className="diag-select-trigger" onKeyDown={keyDown} onClick={() => { setActive(selected); setOpen(value => !value); }}>
      <span>{options[selected]![1]}</span><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <div className="diag-select-menu" role="listbox" aria-label={label} id={id}>
      {options.map(([key, text], index) => <button type="button" role="option" key={key} id={`${id}-${index}`} tabIndex={-1} aria-selected={key === value}
        className={index === active ? 'diag-option-active' : ''} onPointerDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>
        <span>{text}</span><span aria-hidden="true">{key === value ? '✓' : ''}</span>
      </button>)}
    </div>}
  </div>;
}
