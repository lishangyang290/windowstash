import { retainEvents, sanitizeEvent, type DiagnosticEvent } from './diagnostics';

export interface DiagnosticStorage {
  read(): Promise<DiagnosticEvent[]>;
  write(events: DiagnosticEvent[]): Promise<void>;
}
/** Batches per event-loop turn; bounded backlog. Logging failure is observable, never fatal. */
export function diagnosticWriter(storage: DiagnosticStorage) {
  const queue: DiagnosticEvent[] = [];
  let running: Promise<void> | null = null, dropped = 0;
  async function drain() {
    while (queue.length) {
      const batch = queue.splice(0, 128);
      try { await storage.write(retainEvents([...(await storage.read()), ...batch])); }
      catch { dropped += batch.length; }
    }
  }
  return {
    append(event: DiagnosticEvent): Promise<void> {
      const safe = sanitizeEvent(event);
      if (!safe || queue.length >= 256) { dropped++; return Promise.resolve(); }
      queue.push(safe);
      if (!running) running = Promise.resolve().then(drain).finally(() => { running = null; });
      return running;
    },
    async flush() { await running; },
    health: () => ({ dropped, pending: queue.length }),
  };
}
