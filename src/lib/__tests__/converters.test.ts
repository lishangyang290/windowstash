import { describe, expect, it } from 'vitest';
import { cloudRowToLocal } from '@/lib/converters';
import type { CloudWorkspaceRow } from '@/types/workspace';

describe('cloudRowToLocal', () => {
  it('maps snake_case cloud data and sorts tabs by position', () => {
    const row: CloudWorkspaceRow = {
      id: '1', user_id: 'user-1', name: 'PetLifeHub', status: 'review', active_tab_index: 1,
      content_hash: 'hash', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
      tabs: [
        { title: 'B', url: 'https://b.example', position: 1, pinned: false },
        { title: 'A', url: 'https://a.example', position: 0, pinned: true },
      ],
    };
    const result = cloudRowToLocal(row, new Date('2026-01-03T00:00:00.000Z'));
    expect(result.content.tabs.map((tab) => tab.title)).toEqual(['A', 'B']);
    expect(result.content.activeTabIndex).toBe(1);
    expect(result.sync.syncStatus).toBe('synced');
    expect(result.sync.lastSyncedCloudUpdatedAt).toBe(row.updated_at);
  });
});
