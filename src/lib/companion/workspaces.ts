import { browser } from 'wxt/browser';
import { authLink } from './auth';
import { instanceId } from './connection';
import { hex, NATIVE_HOST } from './protocol';
import type { WorkspaceLocalRecord } from '@/types/workspace';
import type { LocalExchange } from '../../../shared/workspaceSync';
import type { TraceContext } from '../../../shared/diagnostics';
import { syncTrace } from '../../../shared/syncDiagnostics';
export class NativeWorkspaceDeletedError extends Error {}

export async function nativeMessage(message: Record<string, unknown>, started: number): Promise<unknown> {
  const remaining = 5_000 - (Date.now() - started);
  if (remaining <= 0) throw new Error('本机工作区通道超时；原数据已保留，请重试');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      browser.runtime.sendNativeMessage(NATIVE_HOST, message),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('本机工作区通道超时；原数据已保留，请重试')), remaining); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function nativeLibraryExchange(scope: string): Promise<LocalExchange | null> {
  const link = await authLink(); if (!link) return null;
  const [project, user] = JSON.parse(scope.slice('workspaces:'.length)) as [string, string];
  const instance = await instanceId();
  return async (action, payload) => {
    const data = await browser.storage.local.get(['windowstash-data-owner:v1', 'supabaseConfig']);
    if (data['windowstash-data-owner:v1'] !== scope.slice('workspaces:'.length)
      || (data.supabaseConfig as { url?: string })?.url !== project || (await authLink())?.capability !== link.capability) throw new Error('账号已变化，同步已停止');
    const reply = await nativeMessage({ version: 1, type: 'workspace_sync', instance_id: instance, capability: link.capability,
      project_url: project, user_id: user, action, ...payload }, Date.now()) as { status?: string; code?: string };
    if (reply?.status === 'error') throw new Error(reply.code ?? '本机同步通道不可用');
    return reply;
  };
}

const PREFIX = 'windowstash-local-library:';
export const libraryStateKey = (scope: string) => `${PREFIX}${scope}`;
interface LibraryState { revision: number; pending: boolean; diagnostic?: TraceContext; operations?: Record<string, TraceContext> }
const tasks = new Map<string, Promise<unknown>>();
function locked<T>(name: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (globalThis.navigator?.locks) return (signal ? navigator.locks.request(name, { signal }, task) : navigator.locks.request(name, task)).then((result) => result);
  const run = () => { signal?.throwIfAborted(); return task(); };
  const result = (tasks.get(name) ?? Promise.resolve()).then(run, run);
  tasks.set(name, result);
  void result.finally(() => { if (tasks.get(name) === result) tasks.delete(name); }).catch(() => undefined);
  return result;
}

/** Commit the mutation and its durable projection marker together. */
export async function persistLibraryChange(scope: string, changes: Record<string, unknown>, diagnostic?: TraceContext) {
  if (!scope.startsWith('workspaces:[')) return browser.storage.local.set(changes);
  await locked(libraryStateKey(scope), async () => {
    const key = libraryStateKey(scope);
    const state = (await browser.storage.local.get(key))[key] as LibraryState | undefined;
    if (state && (!Number.isSafeInteger(state.revision) || state.revision < 1 || state.revision >= Number.MAX_SAFE_INTEGER)) throw new Error('本机投影版本无效，原数据已保留');
    await browser.storage.local.set({ ...changes, [key]: { revision: (state?.revision ?? 0) + 1, pending: true, ...((diagnostic ?? state?.diagnostic) ? { diagnostic: diagnostic ?? state?.diagnostic } : {}), ...(diagnostic?.workspace ? { operations: Object.fromEntries([...Object.entries(state?.operations ?? {}).filter(([id]) => id !== diagnostic.workspace), [diagnostic.workspace, diagnostic]].slice(-64)) } : state?.operations ? { operations: state.operations } : {}) } });
    syncTrace('local.persisted', { trace: diagnostic, scope, revision: (state?.revision ?? 0) + 1 });
  });
}

export function isLibraryChange(key: string, value: unknown): boolean {
  return key.startsWith(PREFIX) && Boolean((value as LibraryState | undefined)?.pending);
}
export const libraryScope = (key: string) => key.slice(PREFIX.length);

/** No cloud request participates in this acknowledgement. Failed sends leave the marker intact. */
export function publishNativeWorkspaces(scope: string, force = false): Promise<void> {
  const started = Date.now();
  const queuedTrace = syncTrace('native.publish.queued', { scope });
  let publishTrace: TraceContext | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  return locked(`publish:${scope}`, async () => {
    // Preserve standalone extension use. No native account is inferred from a local label.
    const link = await authLink();
    if (!link) { syncTrace('native.publish.skipped', { trace: queuedTrace, scope }); return; }
    const key = libraryStateKey(scope);
    const snapshot = await locked(key, async () => {
      const data = await browser.storage.local.get([scope, scope.replace(/^workspaces/, 'deleteTombstones'), scope.replace(/^workspaces/, 'syncRecovery'), key, 'supabaseConfig', 'windowstash-data-owner:v1']);
      const owner = scope.slice('workspaces:'.length);
      if (!scope.startsWith('workspaces:[') || data['windowstash-data-owner:v1'] !== owner) throw new Error('账号已变化，本机待同步数据已保留');
      let state = data[key] as LibraryState | undefined;
      if (!state) {
        state = { revision: 1, pending: true };
        await browser.storage.local.set({ [key]: state });
      }
      if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error('本机投影版本无效，原数据已保留');
      return { data, state, owner };
    });
    if (!snapshot.state.pending && !force) { syncTrace('native.publish.skipped', { trace: queuedTrace, scope }); return; }
    publishTrace = syncTrace('native.publish.start', { trace: snapshot.state.diagnostic ?? queuedTrace, scope, revision: snapshot.state.revision });
    const config = snapshot.data.supabaseConfig as { url: string };
    const owner = JSON.parse(snapshot.owner) as [string, string];
    if (JSON.stringify([new URL(config.url).href.replace(/\/+$/, ''), owner[1]]) !== snapshot.owner) throw new Error('账号配置已变化，本机数据已保留');
    const records = Object.values(snapshot.data[scope] as Record<string, { content: unknown; sync: unknown }> | undefined ?? {}).map(({ content, sync }) => ({ content, sync }));
    const deleted = Object.keys(snapshot.data[scope.replace(/^workspaces/, 'deleteTombstones')] as object | undefined ?? {});
    const recovery = snapshot.data[scope.replace(/^workspaces/, 'syncRecovery')] as Record<string, WorkspaceLocalRecord[]> | undefined;
    const conflicts = Object.fromEntries(Object.entries(recovery ?? {}).map(([id, versions]) => [id, versions.map(({ content, sync }) => ({ content, sync }))]));
    const bytes = new TextEncoder().encode(JSON.stringify({ records, deleted, ...(Object.keys(conflicts).length ? { conflicts } : {}) }));
    if (bytes.length > 8 * 1024 * 1024) throw new Error('本机工作区数据超过传输上限；保存数据已保留');
    const chunks = Math.max(1, Math.ceil(bytes.length / 16_384));
    const envelope = { version: 1, type: 'workspaces', instance_id: await instanceId(), capability: link.capability, project_url: config.url, user_id: owner[1], revision: snapshot.state.revision, chunks, diagnostic: publishTrace };
    for (let index = 0; index < chunks; index++) {
        const reply = await nativeMessage({ ...envelope, ...(index === chunks - 1 ? { diagnostic_operations: snapshot.state.operations } : {}), index, part: hex(bytes.subarray(index * 16_384, (index + 1) * 16_384)) }, started) as { status?: string; revision?: number };
        if (reply?.status !== (index === chunks - 1 ? 'persisted' : 'staged') || reply.revision !== snapshot.state.revision) throw new Error('工作区已保存在扩展本地，但本机通道未确认写入，未关闭窗口；请重试');
    }
    syncTrace('native.publish.persisted', { trace: publishTrace, scope, revision: snapshot.state.revision, count: records.length, deleted: deleted.length, elapsedMs: Date.now() - started });
    await locked(key, async () => {
      const state = (await browser.storage.local.get(key))[key] as LibraryState;
      if (state.revision === snapshot.state.revision) await browser.storage.local.set({ [key]: { ...state, pending: false } });
    });
  }, controller.signal).catch(error => {
    syncTrace('native.publish.failed', { trace: publishTrace ?? queuedTrace, scope, elapsedMs: Date.now() - started });
    if (controller.signal.aborted) throw new Error('本机工作区通道超时；原数据已保留，请重试');
    throw error;
  }).finally(() => clearTimeout(timer));
}

export async function getNativeWorkspace(id: string, scope: string): Promise<WorkspaceLocalRecord | null> {
  const link = await authLink();
  if (!link) return null;
  const started = Date.now();
  const data = await browser.storage.local.get(['supabaseConfig', 'windowstash-data-owner:v1']);
  const owner = scope.slice('workspaces:'.length);
  if (!scope.startsWith('workspaces:[') || data['windowstash-data-owner:v1'] !== owner) throw new Error('账号已变化，请重新打开工作区');
  const [project, userId] = JSON.parse(owner) as [string, string];
  const config = data.supabaseConfig as { url: string };
  if (new URL(config.url).href.replace(/\/+$/, '') !== project) throw new Error('账号配置已变化，请重新打开工作区');
  const envelope = { version: 1, type: 'workspace_read', instance_id: await instanceId(), capability: link.capability, project_url: config.url, user_id: userId, id };
  const parts: Uint8Array[] = [];
  let chunks = 1, revision: number | undefined, generation: number | undefined;
  for (let index = 0; index < chunks; index++) {
    const reply = await nativeMessage({ ...envelope, index, revision, generation }, started) as { status?: string; id?: string; revision?: number; generation?: number; deleted?: boolean; chunks?: number; index?: number; part?: string };
    if (index === 0 && reply?.status === 'missing') {
      if (reply.deleted) throw new NativeWorkspaceDeletedError('工作区已在其他设备删除，当前窗口及标签页不会受到影响。');
      return null;
    }
    if (reply?.status !== 'read' || reply.id !== id || reply.index !== index || !Number.isSafeInteger(reply.revision)
      || (revision !== undefined && revision !== reply.revision) || (generation !== undefined && reply.generation !== generation)
      || (reply.generation !== undefined && (!Number.isSafeInteger(reply.generation) || reply.generation < 0)) || !Number.isSafeInteger(reply.chunks) || reply.chunks! < 1 || reply.chunks! > 512
      || (index > 0 && chunks !== reply.chunks) || typeof reply.part !== 'string' || reply.part.length > 32_768 || !/^(?:[a-f0-9]{2})*$/.test(reply.part)) throw new Error('本机恢复数据校验失败，原数据已保留');
    chunks = reply.chunks!; revision = reply.revision; generation = reply.generation;
    parts.push(Uint8Array.from(reply.part.match(/../g) ?? [], pair => parseInt(pair, 16)));
  }
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as WorkspaceLocalRecord;
  if (record.content?.id !== id || !record.sync) throw new Error('本机恢复数据校验失败，原数据已保留');
  return { ...record, accountStorageKey: scope };
}
