/** Local performance evidence only; never includes account data or error messages. */
export function diagnosticTiming(stage: string, start: number) {
  const durationMs = performance.now() - start;
  performance.measure(`windowstash.diagnostics.${stage}`, { start, duration: durationMs });
  console.info('[diagnostics timing]', stage, Math.round(durationMs * 10) / 10, 'ms');
}
export const yieldDiagnosticUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));
