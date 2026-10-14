import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ storage: new Map<string, unknown>(), send: vi.fn(), link: { capability: 'c'.repeat(64) } as { capability: string } | null }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: { sendNativeMessage: fixture.send },
  storage: { local: {
    get: async (keys: string | string[]) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => fixture.storage.has(key)).map(key => [key, fixture.storage.get(key)])),
    set: async (data: Record<string, unknown>) => { for (const [key, value] of Object.entries(data)) fixture.storage.set(key, value); },
  } },
} }));
vi.mock('../auth', () => ({ authLink: async () => fixture.link }));
vi.mock('../connection', () => ({ instanceId: async () => 'a'.repeat(64) }));
import { libraryStateKey, persistLibraryChange, publishNativeWorkspaces } from '../workspaces';
const owner = JSON.stringify(['https://project.supabase.co', 'user-A']);
const scope = `workspaces:${owner}`;
beforeEach(() => {
  fixture.storage.clear(); fixture.send.mockReset(); fixture.link = { capability: 'c'.repeat(64) };
  fixture.storage.set('supabaseConfig', { url: 'https://project.supabase.co', publishableKey: 'never-export' });
  fixture.storage.set('windowstash-data-owner:v1', owner);
  fixture.send.mockImplementation(async (_host, message) => ({ status: message.index === message.chunks - 1 ? 'persisted' : 'staged', revision: message.revision }));
  vi.stubGlobal('navigator', {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('durable native workspace projection', () => {
  it('preserves existing data when the projection counter is invalid or exhausted', async () => {
    fixture.storage.set(scope, { retained: true });
    fixture.storage.set(libraryStateKey(scope), { revision: Number.MAX_SAFE_INTEGER, pending: false });
    await expect(persistLibraryChange(scope, { [scope]: {} })).rejects.toThrow('版本无效');
    expect(fixture.storage.get(scope)).toEqual({ retained: true });
  });
  it('persists a mutation and its retry marker, clearing it only after native acknowledgement', async () => {
    await persistLibraryChange(scope, { [scope]: { one: { content: { id: 'one' }, sync: {} } } });
    expect(fixture.storage.get(libraryStateKey(scope))).toEqual({ revision: 1, pending: true });
    await publishNativeWorkspaces(scope);
    expect(fixture.storage.get(libraryStateKey(scope))).toEqual({ revision: 1, pending: false });
    expect(JSON.stringify(fixture.send.mock.calls)).not.toContain('never-export');
  });
  it('chunks UTF-8 data and exports cloud downloads and explicit local tombstones', async () => {
    await persistLibraryChange(scope, {
      [scope]: { one: { content: { name: '新下载'.repeat(8_000) }, sync: { syncStatus: 'synced' } } },
      [scope.replace(/^workspaces/, 'deleteTombstones')]: { deleted: {} },
    });
    await publishNativeWorkspaces(scope);
    const messages = fixture.send.mock.calls.map(([, message]) => message);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every(m => new TextEncoder().encode(JSON.stringify(m)).length < 65_536)).toBe(true);
    const bytes = messages.flatMap(m => [...m.part.matchAll(/../g)].map(pair => parseInt(pair[0], 16)));
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)))).toMatchObject({ records: [{ sync: { syncStatus: 'synced' } }], deleted: ['deleted'] });
  });
  it('does not clear a newer mutation when an older send is acknowledged', async () => {
    await persistLibraryChange(scope, { [scope]: {} });
    fixture.send.mockImplementationOnce(async (_host, message) => {
      await persistLibraryChange(scope, { [scope]: {} });
      return { status: 'persisted', revision: message.revision };
    });
    await publishNativeWorkspaces(scope);
    expect(fixture.storage.get(libraryStateKey(scope))).toEqual({ revision: 2, pending: true });
  });
  it('retains the marker on channel failure and retries the same revision', async () => {
    await persistLibraryChange(scope, { [scope]: {} });
    fixture.send.mockRejectedValueOnce(new Error('Host stopped'));
    await expect(publishNativeWorkspaces(scope)).rejects.toThrow('Host stopped');
    expect(fixture.storage.get(libraryStateKey(scope))).toEqual({ revision: 1, pending: true });
    await publishNativeWorkspaces(scope);
    expect(fixture.send.mock.calls.map(([, m]) => m.revision)).toEqual([1, 1]);
  });
  it('times out without waiting forever or losing pending data', async () => {
    vi.useFakeTimers();
    await persistLibraryChange(scope, { [scope]: {} });
    fixture.send.mockImplementationOnce(() => new Promise(() => {}));
    const failed = expect(publishNativeWorkspaces(scope)).rejects.toThrow('写入超时');
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(fixture.storage.get(libraryStateKey(scope))).toEqual({ revision: 1, pending: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not send another account and keeps unpaired installs extension-only', async () => {
    await persistLibraryChange(scope, { [scope]: {} });
    fixture.storage.set('windowstash-data-owner:v1', 'signed-out');
    await expect(publishNativeWorkspaces(scope)).rejects.toThrow('账号已变化');
    expect(fixture.send).not.toHaveBeenCalled();
    fixture.storage.set('windowstash-data-owner:v1', owner); fixture.link = null;
    await expect(publishNativeWorkspaces(scope)).resolves.toBeUndefined();
    expect(fixture.storage.get(libraryStateKey(scope))).toEqual({ revision: 1, pending: true });
  });
  it('reexports existing data at startup without inferring any deletion from absence', async () => {
    fixture.storage.set(scope, { old: { content: { id: 'old' }, sync: {} } });
    await publishNativeWorkspaces(scope, true);
    expect(fixture.storage.get(libraryStateKey(scope))).toEqual({ revision: 1, pending: false });
    await publishNativeWorkspaces(scope, true);
    expect(fixture.send).toHaveBeenCalledTimes(2);
  });
});
