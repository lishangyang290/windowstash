import { browser } from 'wxt/browser';
import { authLink } from './auth';
import { instanceId } from './connection';
import { hex, NATIVE_HOST } from './protocol';

const PREFIX = 'windowstash-local-library:';
export const libraryStateKey = (scope: string) => `${PREFIX}${scope}`;
interface LibraryState { revision: number; pending: boolean }
const tasks = new Map<string, Promise<unknown>>();
function locked<T>(name: string, task: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return navigator.locks.request(name, task).then((result) => result);
  const result = (tasks.get(name) ?? Promise.resolve()).then(task, task);
  tasks.set(name, result);
  void result.finally(() => { if (tasks.get(name) === result) tasks.delete(name); }).catch(() => undefined);
  return result;
}

/** Commit the mutation and its durable projection marker together. */
export async function persistLibraryChange(scope: string, changes: Record<string, unknown>) {
  if (!scope.startsWith('workspaces:[')) return browser.storage.local.set(changes);
  await locked(libraryStateKey(scope), async () => {
    const key = libraryStateKey(scope);
    const state = (await browser.storage.local.get(key))[key] as LibraryState | undefined;
    if (state && (!Number.isSafeInteger(state.revision) || state.revision < 1 || state.revision >= Number.MAX_SAFE_INTEGER)) throw new Error('本机投影版本无效，原数据已保留');
    await browser.storage.local.set({ ...changes, [key]: { revision: (state?.revision ?? 0) + 1, pending: true } });
  });
}

export function isLibraryChange(key: string, value: unknown): boolean {
  return key.startsWith(PREFIX) && Boolean((value as LibraryState | undefined)?.pending);
}
export const libraryScope = (key: string) => key.slice(PREFIX.length);

/** No cloud request participates in this acknowledgement. Failed sends leave the marker intact. */
export function publishNativeWorkspaces(scope: string, force = false): Promise<void> {
  return locked(`publish:${scope}`, async () => {
    const started = Date.now();
    // Preserve standalone extension use. No native account is inferred from a local label.
    const link = await authLink();
    if (!link) return;
    const key = libraryStateKey(scope);
    const snapshot = await locked(key, async () => {
      const data = await browser.storage.local.get([scope, scope.replace(/^workspaces/, 'deleteTombstones'), key, 'supabaseConfig', 'windowstash-data-owner:v1']);
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
    if (!snapshot.state.pending && !force) return;
    const config = snapshot.data.supabaseConfig as { url: string };
    const owner = JSON.parse(snapshot.owner) as [string, string];
    if (JSON.stringify([new URL(config.url).href.replace(/\/+$/, ''), owner[1]]) !== snapshot.owner) throw new Error('账号配置已变化，本机数据已保留');
    const records = Object.values(snapshot.data[scope] as Record<string, { content: unknown; sync: unknown }> | undefined ?? {}).map(({ content, sync }) => ({ content, sync }));
    const deleted = Object.keys(snapshot.data[scope.replace(/^workspaces/, 'deleteTombstones')] as object | undefined ?? {});
    const bytes = new TextEncoder().encode(JSON.stringify({ records, deleted }));
    if (bytes.length > 8 * 1024 * 1024) throw new Error('本机工作区数据超过传输上限；保存数据已保留');
    const chunks = Math.max(1, Math.ceil(bytes.length / 16_384));
    const envelope = { version: 1, type: 'workspaces', instance_id: await instanceId(), capability: link.capability, project_url: config.url, user_id: owner[1], revision: snapshot.state.revision, chunks };
    for (let index = 0; index < chunks; index++) {
      const remaining = 5_000 - (Date.now() - started);
      if (remaining <= 0) throw new Error('本机工作区写入超时；保存数据已保留，请重试');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const reply = await Promise.race([
          browser.runtime.sendNativeMessage(NATIVE_HOST, { ...envelope, index, part: hex(bytes.subarray(index * 16_384, (index + 1) * 16_384)) }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('本机工作区写入超时；保存数据已保留，请重试')), remaining); }),
        ]) as { status?: string; revision?: number };
        if (reply?.status !== (index === chunks - 1 ? 'persisted' : 'staged') || reply.revision !== snapshot.state.revision) throw new Error('工作区已保存在扩展本地，但本机通道未确认写入，未关闭窗口；请重试');
      } finally { clearTimeout(timer); }
    }
    await locked(key, async () => {
      const state = (await browser.storage.local.get(key))[key] as LibraryState;
      if (state.revision === snapshot.state.revision) await browser.storage.local.set({ [key]: { ...state, pending: false } });
    });
  });
}
