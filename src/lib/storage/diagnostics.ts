import { browser } from 'wxt/browser';
import { configureDiagnostics, flushDiagnostics, syncTrace } from '../../../shared/syncDiagnostics';
import { diagnosticRef, makeBundle, retainEvents, type DiagnosticEvent } from '../../../shared/diagnostics';
import { accountStorageKey } from './accountScope';

const PREFIX = 'windowstash-diagnostics:v1:';
const OWNER = 'windowstash-data-owner:v1';
let initialized = false;
let activeOwner = 'signed-out';
let writes = Promise.resolve();
const pendingFlushes = new Map<string, Promise<void>>();
let lost = 0;
const writers = new Map<string, DiagnosticEvent[]>();
export function initializeDiagnostics() {
  if (initialized || !browser.storage?.local) return;
  initialized = true;
  void browser.storage.local.get(OWNER).then(data => { activeOwner = typeof data[OWNER] === 'string' ? data[OWNER] as string : 'signed-out'; syncTrace('lifecycle.start', { scope: activeOwner, trigger: 'startup', source: 'src/lib/storage/diagnostics.ts:initializeDiagnostics' }); }).catch(() => {});
  browser.storage.onChanged?.addListener(changes => { if (changes[OWNER]) { activeOwner = typeof changes[OWNER].newValue === 'string' ? changes[OWNER].newValue : 'signed-out'; if (typeof window !== 'undefined') window.dispatchEvent(new Event('windowstash-diagnostic-account-changed')); } });
  configureDiagnostics({ component: 'extension', captureScope: () => activeOwner, buildId: browser.runtime.getManifest?.().version ?? 'development', sink: async (event, scope) => {
    // Capture account before asynchronous hashing; explicit business scope wins.
    const owner = scope?.replace(/^(workspaces|syncLogs|deleteTombstones):/, '') ?? 'signed-out';
    if (typeof owner !== 'string' || owner === 'signed-out' || !owner.startsWith('[')) return;
    const key = PREFIX + await diagnosticRef(owner);
    const device = 'windowstash-diagnostic-device:v1';
    const batch = writers.get(key) ?? []; batch.push(event); writers.set(key, batch);
    const queued = pendingFlushes.get(key);
    if (queued) { await queued; return; }
    const save = async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      while (batch.length) {
      const append = async () => {
        const next = writers.get(key)?.splice(0, 256) ?? [];
        if (!next.length) return;
        const detailKey = PREFIX + 'detail:' + key.slice(PREFIX.length);
        const data = await browser.storage.local.get([key, device, detailKey]);
        if (Date.now() >= Number(data[detailKey] ?? 0)) for (const e of next) { delete e.state.before; delete e.state.after; }
        const deviceId = typeof data[device] === 'string' ? data[device] as string : await diagnosticRef(crypto.randomUUID());
        const previous = Array.isArray(data[key]) ? data[key] as DiagnosticEvent[] : [];
        await browser.storage.local.set({ [device]: deviceId, [key]: retainEvents([...previous, ...next.map(e => ({ ...e, deviceId, deviceSource: 'profile' as const }))]) });
      };
      if (globalThis.navigator?.locks) await navigator.locks.request(key, append);
      else await append();
      }
    };
    const task = writes.then(save, save).catch(() => { lost++; batch.length = 0; }).finally(() => { pendingFlushes.delete(key); writers.delete(key); });
    pendingFlushes.set(key, task); writes = task;
    await task;
  } });
}
export async function extensionDiagnostics() {
  await flushDiagnostics(); await writes;
  const scope = await accountStorageKey('workspaces');
  if (!scope.startsWith('workspaces:[')) return makeBundle([], { extension: '账号未登录，私人诊断不可访问', 'native-host': '未读取', companion: '未读取' });
  const key = PREFIX + await diagnosticRef(scope.slice('workspaces:'.length));
  const data = await browser.storage.local.get(key);
  return makeBundle(retainEvents(Array.isArray(data[key]) ? data[key] as DiagnosticEvent[] : []), { extension: `本账号本地存储；写入失败批次 ${lost}`, 'native-host': '尚未读取', companion: '扩展无法访问 Companion WebView；可从托盘独立导出' });
}
export async function detailedDiagnostics(minutes = 15) {
  const scope = await accountStorageKey('workspaces');
  if (!scope.startsWith('workspaces:[')) return;
  await browser.storage.local.set({ [PREFIX + 'detail:' + await diagnosticRef(scope.slice('workspaces:'.length))]: Date.now() + Math.min(minutes, 15) * 60_000 });
}
