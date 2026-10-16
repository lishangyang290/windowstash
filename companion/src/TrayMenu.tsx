import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function TrayMenu() {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { menu.current?.focus(); }, []);
  return <div className="tray-menu" role="menu" aria-label="WindowStash" tabIndex={-1} ref={menu} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); void invoke('hide_tray_menu'); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index = items.findIndex(item => item === document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }}>
    <button role="menuitem" onClick={() => void invoke('show_popover')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 9 8-6 8 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 21v-6h6v6"/></svg><span>显示主界面</span></button>
    <div className="tray-menu-separator" role="separator" />
    <button role="menuitem" onClick={() => void invoke('quit_app')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v10M6.3 5.7a9 9 0 1 0 11.4 0" /></svg><span>退出</span></button>
  </div>;
}
