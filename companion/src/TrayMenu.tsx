import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WorkspaceIcon } from './lib/icons';

export default function TrayMenu() {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  return <div className="tray-menu" role="menu" aria-label="WindowStash" ref={menu} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); void invoke('hide_tray_menu'); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index = items.findIndex(item => item === document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }}>
    <button role="menuitem" onClick={() => void invoke('show_popover')}><WorkspaceIcon /><span>打开 WindowStash</span></button>
    <div className="tray-menu-separator" role="separator" />
    <button role="menuitem" className="tray-menu-quit" onClick={() => void invoke('quit_app')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H5v14h5m4-11 4 4-4 4m-5-4h9" /></svg><span>退出 WindowStash</span></button>
  </div>;
}
