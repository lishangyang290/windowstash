import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ state: new Map<string, unknown>(), send: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: {
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, mocks.state.get(key)])),
    set: async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => mocks.state.set(key, value)); },
  } },
  runtime: { sendNativeMessage: mocks.send },
} }));
vi.mock('../connection', () => ({ instanceId: async () => 'browser-instance' }));
import { nativeAuth } from '../auth';

const reply = { capability: 'a'.repeat(64), config: { url: 'https://project.supabase.co', publishable_key: 'public' }, session: { user: { id: 'A' } } };

describe('shared Mac/Windows Native Host reads', () => {
  it('does not join a local identity read to an in-flight cloud refresh', async () => {
    let finish!: (value: typeof reply) => void;
    mocks.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const cloud = nativeAuth('read');
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    await expect(nativeAuth('local')).resolves.toEqual(reply);
    expect(mocks.send.mock.calls[1]?.[1].action).toBe('local');
    finish(reply); await cloud;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.clear();
    mocks.state.set('windowstash-companion:auth-link:v1', { capability: reply.capability });
    mocks.send.mockResolvedValue(reply);
  });

  it('shares concurrent checks but performs a fresh read after completion', async () => {
    let finish!: (value: typeof reply) => void;
    mocks.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = nativeAuth('read'), second = nativeAuth('read');
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    finish(reply);
    await expect(Promise.all([first, second])).resolves.toEqual([reply, reply]);
    await nativeAuth('read');
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('does not retain failed reads and permits recovery', async () => {
    let fail!: (error: Error) => void;
    mocks.send.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const results = Promise.allSettled([nativeAuth('read'), nativeAuth('read')]);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    fail(new Error('host unavailable'));
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(nativeAuth('read')).resolves.toEqual(reply);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it.each(['supabaseConfig', 'windowstash-data-owner:v1', 'windowstash-data-revision:v1', 'windowstash-companion:auth-link:v1'])('isolates an in-flight read when %s changes', async (key) => {
    let finish!: (value: typeof reply) => void;
    mocks.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = nativeAuth('read');
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    mocks.state.set(key, key.endsWith('auth-link:v1') ? { capability: 'b'.repeat(64) } : 'new identity');
    await nativeAuth('read');
    expect(mocks.send).toHaveBeenCalledTimes(2);
    finish(reply);
    await first;
  });

  it('starts a fresh read after a native mutation instead of joining the old read', async () => {
    let finish!: (value: typeof reply) => void;
    mocks.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = nativeAuth('read');
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    await nativeAuth('refresh');
    await nativeAuth('read');
    expect(mocks.send).toHaveBeenCalledTimes(3);
    finish(reply);
    await first;
  });
});
