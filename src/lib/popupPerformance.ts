type Stage = 'identity' | 'supabase-client' | 'supabase-session' | 'native-auth' | 'native-message' | 'current-window' | 'logical-tabs' | 'workspace-resolution' | 'config-storage' | 'native-storage' | 'lazy-storage' | 'account-initialization';
interface Sample { stage: Stage; startMs: number; durationMs: number; ok: boolean }
let enabled = false;
let firstCommitMs: number | null = null;
let readyCommitMs: number | null = null;
const samples: Sample[] = [];

/** Popup-local, bounded diagnostics. No credentials, URLs, IDs or tab data. */
export function startPopupPerformance() {
  enabled = true;
  firstCommitMs = readyCommitMs = null;
  samples.length = 0;
}

export function markPopupCommit(ready: boolean) {
  if (!enabled) return;
  firstCommitMs ??= performance.now();
  if (ready) readyCommitMs ??= performance.now();
}

export async function measurePopupStage<T>(stage: Stage, task: () => Promise<T>): Promise<T> {
  if (!enabled) return task();
  const startMs = performance.now();
  let ok = false;
  try { const value = await task(); ok = true; return value; }
  finally {
    if (samples.length === 200) samples.shift();
    samples.push({ stage, startMs, durationMs: performance.now() - startMs, ok });
  }
}

export function popupPerformanceSnapshot() {
  const paints = performance.getEntriesByType('paint');
  return {
    firstCommitMs,
    firstContentfulPaintMs: paints.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null,
    readyCommitMs,
    // Stages overlap (e.g. Supabase includes Native IPC); do not sum them.
    samples: samples.map((sample) => ({ ...sample })),
  };
}
