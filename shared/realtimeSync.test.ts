import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSync } from './realtimeSync';
afterEach(() => vi.useRealTimers());
describe('Realtime event lifecycle', () => {
  it('starts one subscription, serializes duplicate/late hints, calibrates after reconnect and closes on logout', async () => {
    let hint!: () => void, ready!: () => void, complete!: () => void;
    const stop = vi.fn(), subscribe = vi.fn((a, b) => { hint = a; ready = b; return stop; });
    const reconcile = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; })).mockResolvedValue(undefined);
    const sync = new RealtimeSync(subscribe, reconcile); sync.start(); sync.start();
    hint(); hint(); ready(); expect(reconcile).toHaveBeenCalledTimes(1); complete();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    ready(); await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3));
    sync.stop(); hint(); ready(); expect(reconcile).toHaveBeenCalledTimes(3); expect(stop).toHaveBeenCalledOnce(); expect(subscribe).toHaveBeenCalledOnce();
  });
  it('retries failures with backoff and cancels retries at account switch', async () => {
    vi.useFakeTimers(); const reconcile = vi.fn().mockRejectedValue(new Error('offline'));
    const sync = new RealtimeSync(() => () => {}, reconcile); sync.start();
    await vi.advanceTimersByTimeAsync(5_000); expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999); expect(reconcile).toHaveBeenCalledTimes(2);
    sync.stop(); await vi.advanceTimersByTimeAsync(300_000); expect(reconcile).toHaveBeenCalledTimes(2);
  });
  it('queues readiness and concurrent changes behind an older in-flight snapshot', async () => {
    let ready!: () => void, hint!: () => void, finish!: () => void;
    let cloudVersion = 0, localVersion = -1, concurrent = 0, maximum = 0;
    const reconcile = vi.fn(async () => {
      maximum = Math.max(maximum, ++concurrent);
      const snapshot = cloudVersion;
      if (snapshot === 0) await new Promise<void>(resolve => { finish = resolve; });
      localVersion = snapshot; concurrent--;
    });
    const sync = new RealtimeSync((a, b) => { hint = a; ready = b; return () => {}; }, reconcile);
    sync.start();
    // A change occurs after the startup read, before database subscription readiness.
    cloudVersion = 1; ready();
    // Further notifications must coalesce without concurrent or out-of-order writes.
    cloudVersion = 2; hint(); hint(); finish();
    await vi.waitFor(() => expect(localVersion).toBe(2));
    expect(reconcile).toHaveBeenCalledTimes(2); expect(maximum).toBe(1);
    sync.stop();
  });
  it('eventually calibrates readiness received during a failed snapshot and cancels stopped callbacks', async () => {
    vi.useFakeTimers();
    let ready!: () => void, reject!: (error: Error) => void;
    const reconcile = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
    const sync = new RealtimeSync((_hint, callback) => { ready = callback; return () => {}; }, reconcile);
    sync.start(); ready(); reject(new Error('temporary network error'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    sync.stop(); ready(); await vi.advanceTimersByTimeAsync(300_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
