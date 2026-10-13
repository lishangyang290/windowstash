import { afterEach, expect, it, vi } from 'vitest';
import { markPopupCommit, measurePopupStage, popupPerformanceSnapshot, startPopupPerformance } from '../popupPerformance';

afterEach(() => vi.restoreAllMocks());

it('measures elapsed work and DOM commits without recording private results', async () => {
  let now = 10;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  startPopupPerformance();
  markPopupCommit(false);
  await measurePopupStage('identity', async () => { now = 35; return { access_token: 'private-token', user: { id: 'private-user' } }; });
  markPopupCommit(true);
  const snapshot = popupPerformanceSnapshot();
  expect(snapshot.firstCommitMs).toBe(10);
  expect(snapshot.readyCommitMs).toBe(35);
  expect(snapshot.samples).toEqual([{ stage: 'identity', startMs: 10, durationMs: 25, ok: true }]);
  expect(JSON.stringify(snapshot)).not.toContain('private');
});

it('records failed stages, preserves errors, and permits a fresh successful measurement', async () => {
  startPopupPerformance();
  const error = new Error('private failure detail');
  await expect(measurePopupStage('native-message', async () => { throw error; })).rejects.toBe(error);
  await measurePopupStage('native-message', async () => undefined);
  expect(popupPerformanceSnapshot().samples.map(({ ok }) => ok)).toEqual([false, true]);
  expect(JSON.stringify(popupPerformanceSnapshot())).not.toContain(error.message);
});

it('bounds in-memory samples and exports copies rather than mutable state', async () => {
  startPopupPerformance();
  for (let i = 0; i < 205; i++) await measurePopupStage('current-window', async () => undefined);
  const snapshot = popupPerformanceSnapshot();
  expect(snapshot.samples).toHaveLength(200);
  snapshot.samples[0]!.durationMs = -1;
  expect(popupPerformanceSnapshot().samples[0]!.durationMs).toBeGreaterThanOrEqual(0);
  startPopupPerformance();
  expect(popupPerformanceSnapshot().samples).toEqual([]);
});
