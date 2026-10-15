import React from 'react';
import { browser } from 'wxt/browser';

export function PageShell({ manager = false, children }: { manager?: boolean; children: React.ReactNode }) {
  return <div className={`page-shell${manager ? ' manager-page' : ''}`}>
    <header className="config-site-header"><div className="config-site-header-inner">
      <div className="config-site-brand"><img className="config-site-mark" src="/icon-128.png" alt="" />WindowStash</div>
      <a className="config-full-guide" href={browser.runtime.getURL('/开始使用.html')} target="_blank" rel="noopener noreferrer">查看完整教程 ↗</a>
    </div></header>
    <div className="page-content">{children}</div>
  </div>;
}
