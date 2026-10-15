import { expect, it, vi } from 'vitest';
import { subscribeWorkspaceChanges } from './workspaceRealtime';

it('registers before joining, waits for database readiness, and ignores closed subscription callbacks', async () => {
  const handlers: Record<string, ((payload: never) => void)[]> = {};
  let status!: (status: string) => void;
  const channel = {
    on: vi.fn((event: string, _filter: unknown, callback: (payload: never) => void) => {
      (handlers[event] ??= []).push(callback);
    }),
    subscribe: vi.fn(callback => {
      status = callback;
    }),
  };
  const removals: (() => void)[] = [];
  const client = {
    channel: vi.fn<(name: string, options: unknown) => typeof channel>(() => channel),
    removeChannel: vi.fn(() => new Promise<void>(resolve => { removals.push(resolve); })),
  };
  const hint = vi.fn(), ready = vi.fn();
  const close = subscribeWorkspaceChanges(client, 'account-A', hint, ready);
  expect(handlers.postgres_changes).toHaveLength(3);
  expect(handlers.system).toHaveLength(1);
  expect(channel.on.mock.invocationCallOrder.every(order => order < channel.subscribe.mock.invocationCallOrder[0]!)).toBe(true);
  expect(client.channel).toHaveBeenCalledWith(expect.stringMatching(/^windowstash-sync:account-A:/), {
    config: { postgres_changes_options: { wait: true, timeout: 20_000 } },
  });
  status('CHANNEL_ERROR'); status('TIMED_OUT');
  const system = handlers.system![0] as (payload: { extension: string; status: string }) => void;
  system({ extension: 'postgres_changes', status: 'error' });
  system({ extension: 'unrelated', status: 'ok' });
  expect(ready).not.toHaveBeenCalled();
  status('SUBSCRIBED');
  system({ extension: 'postgres_changes', status: 'ok' });
  expect(ready).toHaveBeenCalledTimes(2);
  const closing = close();
  status('SUBSCRIBED'); system({ extension: 'postgres_changes', status: 'ok' });
  handlers.postgres_changes![0]!({} as never);
  expect(hint).not.toHaveBeenCalled(); expect(ready).toHaveBeenCalledTimes(2);
  const closeNext = subscribeWorkspaceChanges(client, 'account-A', hint, ready);
  expect(client.channel.mock.calls[0]![0]).not.toBe(client.channel.mock.calls[1]![0]);
  const finishNext = closeNext();
  // First close remains pending; callbacks were already disabled synchronously.
  removals.forEach(resolve => resolve());
  await Promise.all([closing, finishNext]);
});
