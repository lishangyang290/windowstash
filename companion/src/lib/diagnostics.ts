import { cache, accountOwner } from './cache';
import { getSupabaseClient, getSupabaseConfig } from './supabase';
import { diagnosticWriter } from '../../../shared/diagnosticStore';
import { invoke } from '@tauri-apps/api/core';
import { configureDiagnostics, flushDiagnostics, syncTrace } from '../../../shared/syncDiagnostics';
import { diagnosticRef, makeBundle, type DiagnosticEvent } from '../../../shared/diagnostics';
import { currentBrowserGrant, grantIdentity, readBrowserGrant } from './browserAuth';

let initialized = false;
let lost = 0;
let detailedUntil = 0;
const localWriters = new Map<string, ReturnType<typeof diagnosticWriter>>();
async function bounded<T>(task: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic_read_timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
const batches = new Map<string, { events: DiagnosticEvent[]; promise: Promise<void> }>();
export function initializeDiagnostics() {
  if (initialized) return;
  initialized = true;
  configureDiagnostics({ component: 'companion', captureScope: () => { const grant = currentBrowserGrant(); return grant ? grantIdentity(grant) : cache.currentScope(); }, sink: async (event, scope) => {
    const grant = currentBrowserGrant();
    if (!scope || scope === 'signed-out' || (grant ? scope !== grantIdentity(grant) : scope !== cache.currentScope())) return;
    const identity = grant ? grantIdentity(grant) : scope;
    const deviceKey = 'windowstash-diagnostic-device:v1';
    let device = localStorage.getItem(deviceKey);
    if (!device) { device = await diagnosticRef(crypto.randomUUID()); localStorage.setItem(deviceKey, device); }
    event.deviceId = device; event.deviceSource = 'app';
    detailedUntil = Number(localStorage.getItem('windowstash-diagnostic-detail-until:v1') ?? 0);
    if (Date.now() >= detailedUntil) { delete event.state.before; delete event.state.after; }
    {
      const key = 'windowstash-diagnostics:v1:' + await diagnosticRef(grant ? accountOwner(grant.config.url, grant.session.user.id) : scope);
      let local = localWriters.get(key);
      if (!local) {
        local = diagnosticWriter({ read: async () => JSON.parse(localStorage.getItem(key) ?? '[]') as DiagnosticEvent[], write: async entries => { localStorage.setItem(key, JSON.stringify(entries)); } });
        localWriters.clear(); localWriters.set(key, local);
      }
      await local.append(event); if (!grant) return;
    }
    let batch = batches.get(identity);
    if (!batch) {
      const events: DiagnosticEvent[] = [];
      const promise = new Promise<void>(resolve => setTimeout(resolve, 50)).then(async () => {
        batches.delete(identity);
        // Rust verifies the selected account again; an account switch cannot redirect old entries.
        const result = await invoke<{ dropped: number }>('diagnostic_records', { instance: grant.instance_id, project: grant.config.url, user: grant.session.user.id,
          entries: events.map(e => ({ ...e, timestamp: Date.parse(e.timestamp) })) });
        lost += result.dropped;
      }).catch(() => { lost += events.length; });
      batch = { events, promise }; batches.set(identity, batch);
    }
    if (batch.events.length >= 128) { lost++; return; }
    batch.events.push(event); await batch.promise;
  } });
  syncTrace('lifecycle.start', { trigger: 'startup', source: 'companion/src/lib/diagnostics.ts:initializeDiagnostics' });
}
export async function companionDiagnostics() {
  await bounded(flushDiagnostics(), 1000).catch(() => { lost++; });
  let grant;
  try { grant = await bounded(readBrowserGrant()); }
  catch { return makeBundle([], { companion: '账号授权读取超时或不可用；私人日志未读取', 'native-host': '组件不可用，可能仍在等待；没有足够证据判断原因', extension: '不可访问扩展专属存储' }); }
  if (!grant) {
    const config = getSupabaseConfig(), client = getSupabaseClient();
    const session = client ? (await client.auth.getSession()).data.session : null;
    const entries = session && config ? JSON.parse(localStorage.getItem('windowstash-diagnostics:v1:' + await diagnosticRef(accountOwner(config.url, session.user.id))) ?? '[]') as DiagnosticEvent[] : [];
    return makeBundle(entries, { companion: session ? '本账号独立 Companion 本地记录' : '本机界面运行中；无已授权账号', 'native-host': '私人日志需要浏览器账号授权', extension: 'Chrome 关闭时不可访问扩展专属存储' });
  }
  const local = JSON.parse(localStorage.getItem('windowstash-diagnostics:v1:' + await diagnosticRef(accountOwner(grant.config.url, grant.session.user.id))) ?? '[]') as DiagnosticEvent[];
  let result;
  try { result = await bounded(invoke<{ events: DiagnosticEvent[]; dropped: number; nativeDropped: number }>('diagnostic_records', { instance: grant.instance_id, project: grant.config.url, user: grant.session.user.id, entries: [] })); }
  catch { return makeBundle(local, { companion: '已读取本账号前端本地记录', 'native-host': '组件不可用或读取超时；未合并 Rust / Host 文件', extension: '不可访问扩展专属存储' }); }
  const deviceId = result.events.find(e => /^[a-f0-9]{64}$/.test(e.deviceId))?.deviceId;
  const merged = [...local.map(e => deviceId ? { ...e, deviceId, deviceSource: 'native' as const } : e), ...result.events];
  return makeBundle(merged, { companion: `本机界面运行中；写入丢失 ${lost} 条（当前进程）`, 'native-host': `已读取本账号共享持久化文件；无需 Chrome 运行；本进程后台写入丢失 ${result.nativeDropped} 条`, extension: '扩展专属存储不可访问；可导入 Chrome 导出的文件合并' });
}
export async function detailedDiagnostics() {
  detailedUntil = Date.now() + 15 * 60_000;
  localStorage.setItem('windowstash-diagnostic-detail-until:v1', String(detailedUntil));
}
