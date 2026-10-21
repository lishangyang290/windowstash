import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { QUICK_SAVE_COMMAND } from '@/features/workspaces/quickSaveProtocol';

export function ShortcutSettings({ onOpened }: { onOpened?: () => void }) {
  const [shortcut, setShortcut] = useState('读取中…');
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => { void browser.commands.getAll().then(commands => {
      setShortcut(commands.find(command => command.name === QUICK_SAVE_COMMAND)?.shortcut || '未设置'); setError('');
    }).catch(() => setError('无法读取快捷键设置')); };
    refresh(); window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  return <>
    <button type="button" role="menuitem" className="shortcut-menu-item" title={`当前快捷键：${shortcut}`} onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' }).then(() => onOpened?.()).catch(() => setError('无法打开 Chrome 快捷键设置'))}><span>快捷键设置</span><span className="shortcut-value">{shortcut}</span></button>
    {error && <p role="alert">{error}</p>}
  </>;
}
