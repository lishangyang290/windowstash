import { describe, expect, it } from 'vitest';
import { contentHash } from '@/lib/hash';
import type { WorkspaceContent } from '@/types/workspace';

const content: WorkspaceContent = {
  id: 'workspace-1',
  name: 'PetLifeHub',
  status: 'active',
  tabs: [
    { title: '首页', url: 'https://example.com', position: 0, pinned: false },
    { title: '设计稿', url: 'https://example.com/design', position: 1, pinned: true },
  ],
  activeTabIndex: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('contentHash', () => {
  it('ignores ids and timestamps', async () => {
    const changedMetadata = { ...content, id: 'workspace-2', updatedAt: '2026-09-24T00:00:00.000Z' };
    expect(await contentHash(content)).toBe(await contentHash(changedMetadata));
  });

  it('changes when real workspace content changes', async () => {
    expect(await contentHash(content)).not.toBe(await contentHash({ ...content, status: 'review' }));
  });
});
