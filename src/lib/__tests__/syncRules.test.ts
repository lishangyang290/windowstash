import { describe, expect, it } from 'vitest';
import { canCleanLocalCopy, decideSync } from '@/lib/syncRules';
import type { WorkspaceLocalRecord } from '@/types/workspace';

function record(syncStatus: WorkspaceLocalRecord['sync']['syncStatus'] = 'synced'): WorkspaceLocalRecord {
  return {
    content: {
      id: '1', name: 'Workspace', status: 'active', tabs: [], activeTabIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    sync: {
      syncStatus,
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      lastSyncedHash: 'old-hash',
      lastSyncedCloudUpdatedAt: '2026-01-01T00:00:00.000Z',
      localExpiresAt: '2026-02-01T00:00:00.000Z',
      lastSyncError: null,
    },
  };
}

describe('decideSync', () => {
  it('uploads local-only changes', () => {
    expect(decideSync(record('pending'), 'new-local', 'old-hash', '2026-01-01T00:00:00.000Z')).toBe('upload');
  });

  it('downloads cloud-only changes', () => {
    expect(decideSync(record(), 'old-hash', 'new-cloud', '2026-01-02T00:00:00.000Z')).toBe('download');
  });

  it('detects concurrent local and cloud changes', () => {
    expect(decideSync(record('pending'), 'new-local', 'new-cloud', '2026-01-02T00:00:00.000Z')).toBe('conflict');
  });

  it('does nothing when both sides match', () => {
    expect(decideSync(record(), 'old-hash', 'old-hash', '2026-01-01T00:00:00.000Z')).toBe('noop');
  });
});

describe('canCleanLocalCopy', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');

  it('only cleans expired synced copies', () => {
    expect(canCleanLocalCopy('synced', '2026-02-01T00:00:00.000Z', now)).toBe(true);
    expect(canCleanLocalCopy('synced', '2026-04-01T00:00:00.000Z', now)).toBe(false);
  });

  it.each(['pending', 'failed', 'conflict'] as const)('never cleans expired %s data', (status) => {
    expect(canCleanLocalCopy(status, '2020-01-01T00:00:00.000Z', now)).toBe(false);
  });
});
