import { afterEach, expect, it, vi } from 'vitest';
import { makeBundle } from './diagnostics';
import { prepareDiagnosticExport } from './diagnosticExport';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('receives prepared data and terminates the worker after completion', async () => {
  const terminate = vi.fn(), bundle = makeBundle([]);
  class WorkerMock {
    onmessage?: (event: { data: unknown }) => void;
    terminate = terminate;
    postMessage = vi.fn(() => queueMicrotask(() => this.onmessage?.({ data: { bundle, json: JSON.stringify(bundle, null, 2) } })));
  }
  vi.stubGlobal('Worker', WorkerMock);
  await expect(prepareDiagnosticExport(bundle, [])).resolves.toMatchObject({ bundle, json: JSON.stringify(bundle, null, 2) });
  expect(terminate).toHaveBeenCalledOnce();
});
it('terminates a stuck worker and rejects instead of leaving export disabled indefinitely', async () => {
  vi.useFakeTimers(); const terminate = vi.fn();
  vi.stubGlobal('Worker', class { terminate = terminate; postMessage() {} });
  const task = expect(prepareDiagnosticExport(makeBundle([]), [])).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(30_000); await task;
  expect(terminate).toHaveBeenCalledOnce();
});
