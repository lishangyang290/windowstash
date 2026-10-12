import React from 'react';

const DOMAINS = ['gmail.com', 'qq.com', '163.com', 'outlook.com', '126.com', 'icloud.com', 'hotmail.com', 'foxmail.com'];
export function emailSuggestions(value: string): string[] {
  const [name, domain, extra] = value.split('@');
  if (!name || domain === undefined || extra !== undefined || /\s/.test(value)) return [];
  const query = domain.toLowerCase();
  return DOMAINS.filter((item) => item.startsWith(query) && item !== query).map((item) => `${name}@${item}`);
}

export function EmailInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const composing = React.useRef(false);
  const list = React.useRef<HTMLDivElement>(null);
  const suggestions = emailSuggestions(value);
  const shown = open && suggestions.length > 0;
  React.useEffect(() => { if (shown) list.current?.children[active]?.scrollIntoView?.({ block: 'nearest' }); }, [active, shown]);
  function choose(email: string) { onChange(email); setOpen(false); setActive(0); }
  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || composing.current) return;
    if (event.key === 'Escape' && shown) { event.preventDefault(); setOpen(false); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && suggestions.length) {
      event.preventDefault(); setOpen(true);
      setActive((index) => open ? (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length : event.key === 'ArrowDown' ? 0 : suggestions.length - 1);
    } else if (event.key === 'Enter' && shown && suggestions[active]) { event.preventDefault(); choose(suggestions[active]); }
  }
  return <div className="email-input-wrap">
    <input type="email" role="combobox" aria-label="邮箱" aria-autocomplete="list" aria-expanded={shown} aria-controls={shown ? id : undefined} aria-activedescendant={shown ? `${id}-${active}` : undefined} placeholder="输入邮箱" autoComplete="email" autoCapitalize="none" spellCheck={false} value={value} onChange={(event) => { onChange(event.target.value); setActive(0); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
    {shown && <div ref={list} className="email-suggestions" role="listbox" id={id} aria-label="常用邮箱">
      {suggestions.map((email, index) => <button type="button" role="option" tabIndex={-1} id={`${id}-${index}`} aria-selected={index === active} key={email} onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(email)}>{email}</button>)}
    </div>}
  </div>;
}
