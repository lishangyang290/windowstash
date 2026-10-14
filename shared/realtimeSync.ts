/** Events are hints only. Each SUBSCRIBED (including reconnect) runs a full calibration. */
export class RealtimeSync {
  private unsubscribe: (() => void) | null = null;
  private stopped = true;
  private running = false;
  private requested = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private delay = 5_000;
  constructor(private readonly subscribe: (hint: () => void, ready: () => void) => () => void,
    private readonly reconcile: () => Promise<unknown>, private readonly onError: (error: unknown) => void = () => {}) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const hint = () => this.kick();
    this.unsubscribe = this.subscribe(hint, hint);
    this.kick();
  }
  kick() {
    if (this.stopped) return;
    this.requested = true;
    clearTimeout(this.retry); this.retry = undefined;
    if (!this.running) { this.running = true; void this.drain(); }
  }
  private async drain() {
    try {
      while (this.requested && !this.stopped) {
        this.requested = false;
        try { await this.reconcile(); this.delay = 5_000; }
        catch (error) {
          this.onError(error);
          this.requested = false;
          if (!this.stopped) {
            this.retry = setTimeout(() => this.kick(), this.delay);
            this.delay = Math.min(5 * 60_000, this.delay * 2);
          }
        }
      }
    } finally { this.running = false; }
  }
  stop() {
    this.stopped = true; this.requested = false; clearTimeout(this.retry);
    this.unsubscribe?.(); this.unsubscribe = null;
  }
}
