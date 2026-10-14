import { browser, type Browser } from 'wxt/browser';
import { authLink } from '@/lib/companion/auth';
import { instanceId } from '@/lib/companion/connection';
import { NATIVE_HOST } from '@/lib/companion/protocol';
import { nativeLibraryExchange } from '@/lib/companion/workspaces';
import { importNativeLibrary } from './nativeImport';
let port: Browser.runtime.Port | null = null, current = '', sequence = 0;
export async function watchNativeLibrary(scope: string) {
  const revision = ++sequence;
  const link = await authLink();
  const watchKey = `${scope}:${link?.capability ?? ''}`;
  if (port && current === watchKey) return;
  port?.disconnect(); port = null; current = '';
  if (!link || !scope.startsWith('workspaces:[')) return;
  const exchange = await nativeLibraryExchange(scope); if (!exchange || revision !== sequence) return;
  const [project, user] = JSON.parse(scope.slice('workspaces:'.length)) as [string, string];
  const instance = await instanceId(); if (revision !== sequence) return;
  const channel = browser.runtime.connectNative(NATIVE_HOST); port = channel; current = watchKey;
  channel.onMessage.addListener(message => {
    if (port !== channel || message?.status !== 'changed') return;
    void importNativeLibrary(scope, exchange).catch(() => undefined);
  });
  channel.onDisconnect.addListener(() => { if (port === channel) { port = null; current = ''; void browser.alarms.create('windowstash-local-library-retry', { delayInMinutes: 1 }); } });
  channel.postMessage({ version: 1, type: 'workspace_watch', instance_id: instance, capability: link.capability, project_url: project, user_id: user, action: 'signal' });
}
export async function pullNativeLibrary(scope: string) {
  const exchange = await nativeLibraryExchange(scope); if (exchange) await importNativeLibrary(scope, exchange);
}
