import { describe, expect, it } from 'vitest';
import { matchWorkspace } from '@/features/workspaces/workspaceMatcher';
import type { WorkspaceLocalRecord } from '@/types/workspace';

function workspace(id: string, urls: string[], pinned: number[] = []): WorkspaceLocalRecord {
  return {
    content: {
      id,
      name: id,
      status: 'active',
      tabs: urls.map((url, position) => ({ title: url, url, position, pinned: pinned.includes(position) })),
      activeTabIndex: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    sync: {
      syncStatus: 'synced',
      lastSyncedAt: null,
      lastSyncedHash: null,
      lastSyncedCloudUpdatedAt: null,
      localExpiresAt: '2026-10-01T00:00:00.000Z',
      lastSyncError: null,
    },
  };
}

function current(urls: string[], pinned: number[] = []) {
  return urls.map((url, index) => ({ url, index, pinned: pinned.includes(index) }));
}

describe('matchWorkspace', () => {
  it('recognizes an exact ordered match including pinned state', () => {
    const record = workspace('one', ['A', 'B', 'C', 'D'], [0]);
    expect(matchWorkspace(current(['A', 'B', 'C', 'D'], [0]), [record])).toBe(record);
  });

  it('handles duplicate URLs as a multiset', () => {
    const record = workspace('duplicates', ['A', 'A', 'B', 'C']);
    expect(matchWorkspace(current(['A', 'A', 'B', 'C']), [record])).toBe(record);
  });

  it('selects the only matching workspace', () => {
    const first = workspace('one', ['A', 'B', 'C', 'D']);
    const second = workspace('two', ['X', 'Y', 'Z']);
    expect(matchWorkspace(current(['A', 'B', 'C', 'D']), [first, second])).toBe(first);
  });

  it('refuses to choose between highly similar candidates', () => {
    const first = workspace('one', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'X']);
    const second = workspace('two', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'Y']);
    expect(matchWorkspace(current(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'Z']), [first, second])).toBeNull();
  });

  it('rejects a low-overlap window', () => {
    const record = workspace('one', ['A', 'B', 'C', 'D']);
    expect(matchWorkspace(current(['A', 'X', 'Y', 'Z']), [record])).toBeNull();
  });

  it('accepts a unique high-confidence match with one restored tab missing', () => {
    const urls = Array.from({ length: 20 }, (_, index) => `https://example.com/${index}`);
    const record = workspace('one', urls, [0, 4]);
    expect(matchWorkspace(current(urls.slice(0, 19), [0, 4]), [record])).toBe(record);
  });

  it('refuses duplicate exact candidates', () => {
    const first = workspace('one', ['A', 'B']);
    const second = workspace('two', ['A', 'B']);
    expect(matchWorkspace(current(['A', 'B']), [first, second])).toBeNull();
  });
});
