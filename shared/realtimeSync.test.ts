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
});
