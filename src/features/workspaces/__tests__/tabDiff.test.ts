import { describe, expect, it } from 'vitest';
import { calculateTabDiff, getTabDomain, getTabLocation } from '@/features/workspaces/tabDiff';
import type { StoredTab } from '@/types/workspace';

const saved = (title: string, url: string, position: number, pinned = false): StoredTab => ({ title, url, position, pinned });

describe('calculateTabDiff', () => {
  it('A. returns no changes when the snapshots match', () => {
    const previous = [saved('A', 'https://a.example', 0), saved('B', 'https://b.example', 1)];
    const current = [
      { id: 1, title: 'A', url: 'https://a.example', index: 0 },
      { id: 2, title: 'B', url: 'https://b.example', index: 1 },
    ];
    expect(calculateTabDiff(previous, current)).toEqual({ added: [], removed: [], updated: [] });
  });

  it('B. reports two tabs that will be added', () => {
    const diff = calculateTabDiff([], [
      { id: 1, title: 'A', url: 'https://a.example', index: 0 },
      { id: 2, title: 'B', url: 'https://b.example', index: 1 },
    ]);
    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(0);
  });

  it('C. reports two tabs that will be removed', () => {
    const diff = calculateTabDiff([saved('A', 'https://a.example', 0), saved('B', 'https://b.example', 1)], []);
    expect(diff.removed).toHaveLength(2);
    expect(diff.added).toHaveLength(0);
  });

  it('D. treats an identical URL and saved state as unchanged', () => {
    const diff = calculateTabDiff([saved('Dashboard', 'https://app.example/path', 0, true)], [
      { id: 42, title: 'Dashboard', url: 'https://app.example/path', index: 0, pinned: true },
    ]);
    expect(diff).toEqual({ added: [], removed: [], updated: [] });
  });

  it('E. classifies a tracking-only URL change as an update', () => {
    const diff = calculateTabDiff([saved('Search', 'https://www.example.com/search?q=window', 0)], [
      { id: 1, title: 'Search', url: 'https://example.com/search?utm_source=mail&q=window#top', index: 0 },
    ]);
    expect(diff.updated).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('F. classifies a high-confidence bing.com subdomain redirect as an update', () => {
    const diff = calculateTabDiff([saved('快手后台 - 搜索', 'https://cn.bing.com/search', 3)], [
      { id: 9, title: '快手后台 - 搜索', url: 'https://bing.com/search', index: 3 },
    ]);
    expect(diff.updated).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('G. does not merge clearly different pages from the same domain', () => {
    const diff = calculateTabDiff([saved('Project overview', 'https://app.example/projects/alpha', 0)], [
      { id: 8, title: 'Project overview', url: 'https://app.example/settings/billing', index: 0 },
    ]);
    expect(diff.updated).toHaveLength(0);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  it('H. preserves duplicate URL counts', () => {
    const previous = [
      saved('A first', 'https://a.example', 0),
      saved('A second', 'https://a.example', 1),
      saved('B', 'https://b.example', 2),
    ];
    const current = [
      { id: 11, title: 'A first', url: 'https://a.example', index: 0 },
      { id: 12, title: 'B', url: 'https://b.example', index: 1 },
    ];
    const diff = calculateTabDiff(previous, current);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toEqual([{ kind: 'removed', ...previous[1] }]);
  });

  it('I. removes a missing item after that saved tab is reopened', () => {
    const previous = [saved('A', 'https://a.example', 0), saved('B', 'https://b.example', 1)];
    const before = calculateTabDiff(previous, [{ id: 1, title: 'A', url: 'https://a.example', index: 0 }]);
    const after = calculateTabDiff(previous, [
      { id: 1, title: 'A', url: 'https://a.example', index: 0 },
      { id: 2, title: 'B', url: 'https://b.example', index: 1 },
    ]);
    expect(before.removed).toHaveLength(1);
    expect(after.removed).toHaveLength(0);
  });

  it('J. keeps every occurrence in a large change set', () => {
    const previous = Array.from({ length: 50 }, (_, index) => saved(`Removed ${index}`, `https://removed-${index}.example`, index));
    const current = Array.from({ length: 80 }, (_, index) => ({ id: index, title: `Added ${index}`, url: `https://added-${index}.example`, index }));
    const diff = calculateTabDiff(previous, current);
    expect(diff.added).toHaveLength(80);
    expect(diff.removed).toHaveLength(50);
  });

  it('reports pinned and title changes as updates without treating position shifts as updates', () => {
    const diff = calculateTabDiff([saved('A', 'https://a.example', 0)], [
      { id: 1, title: 'A renamed', url: 'https://a.example', index: 4, pinned: true },
    ]);
    expect(diff.updated).toHaveLength(1);
    expect(diff.updated[0]?.previous.pinned).toBe(false);
  });

  it('ignores invisible formatting characters in otherwise identical titles', () => {
    const diff = calculateTabDiff([saved('\u200bDashboard', 'https://a.example', 0)], [
      { id: 1, title: 'Dashboard', url: 'https://a.example', index: 0 },
    ]);
    expect(diff.updated).toHaveLength(0);
  });
});

describe('tab labels', () => {
  it('shows compact domains and paths without technical URL details', () => {
    expect(getTabDomain('https://www.example.com/path')).toBe('example.com');
    expect(getTabDomain('chrome://extensions')).toBe('chrome');
    expect(getTabDomain('about:blank')).toBe('about:blank');
    expect(getTabLocation('https://www.example.com/path/to?q=secret#hash')).toBe('example.com/path/to');
  });
});
