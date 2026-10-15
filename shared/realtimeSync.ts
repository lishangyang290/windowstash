import type { TraceContext } from './diagnostics';
import { traceContext } from './syncDiagnostics';
import { syncFailure, syncTrace } from './syncDiagnostics';
/** Events are hints only. Each SUBSCRIBED (including reconnect) runs a full calibration. */
export class RealtimeSync {
  private unsubscribe: (() => void) | null = null;
  private stopped = true;
  private running = false;
  private requested = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private delay = 5_000;
  private run = 0;
  private trace = traceContext('startup');
  private attempt = 0;
  private active: TraceContext | undefined;
  constructor(private readonly subscribe: (hint: (trace?: TraceContext) => void, ready: () => void) => () => void,
    private readonly reconcile: (trace?: TraceContext) => Promise<unknown>, private readonly onError: (error: unknown) => void = () => {}) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const hint = (trace?: TraceContext) => this.kick('realtime', trace);
    this.unsubscribe = this.subscribe(hint, () => this.kick('ready'));
    this.kick('startup');
  }
  kick(trigger = 'manual', cause?: TraceContext) {
    if (this.stopped) return;
    const incoming = cause ?? traceContext(trigger);
    if (this.requested && this.running) syncTrace('sync.coalesced', { trace: this.trace, blockedByOperationId: incoming.operationId, result: 'cancelled' });
    this.trace = syncTrace('sync.request', { trace: incoming, trigger, queued: this.running, queueDepth: this.running ? 1 : 0, blockedByOperationId: this.active?.operationId });
    this.requested = true;
    clearTimeout(this.retry); this.retry = undefined;
    if (!this.running) { this.running = true; void this.drain(); }
  }
  private async drain() {
    try {
      while (this.requested && !this.stopped) {
        this.requested = false;
        const run = ++this.run, started = performance.now();
        const trace = syncTrace('sync.start', { trace: this.trace, run });
        this.active = trace;
        try { await this.reconcile(trace); this.attempt = 0; this.delay = 5_000; syncTrace('sync.done', { trace, run, elapsedMs: performance.now() - started }); }
        catch (error) {
          syncTrace('sync.failed', { trace, run, elapsedMs: performance.now() - started, queued: this.requested, failure: syncFailure(error) });
          this.onError(error);
          if (!this.stopped && !this.requested) {
            syncTrace('sync.retry', { trace, run, retryAttempt: ++this.attempt, retryMs: this.delay });
            this.retry = setTimeout(() => this.kick('retry', trace), this.delay);
            this.delay = Math.min(5 * 60_000, this.delay * 2);
          }
        }
      }
    } finally { this.running = false; this.active = undefined; }
  }
  stop() {
    syncTrace('sync.stop', { trace: this.trace, queued: this.requested, result: 'cancelled' });
    this.stopped = true; this.requested = false; clearTimeout(this.retry);
    this.unsubscribe?.(); this.unsubscribe = null;
  }
}
