import { describe, expect, it } from 'vitest';
import { calculateTabDiff, getTabDomain } from '@/features/workspaces/tabDiff';
import type { StoredTab } from '@/types/workspace';

const saved = (title: string, url: string, position: number): StoredTab => ({
  title,
  url,
  position,
  pinned: false,
});

describe('calculateTabDiff', () => {
  it('returns no changes when the snapshots match', () => {
    const previous = [saved('A', 'https://a.example', 0), saved('B', 'https://b.example', 1)];
    const current = [
      { id: 1, title: 'A', url: 'https://a.example', index: 0 },
      { id: 2, title: 'B', url: 'https://b.example', index: 1 },
    ];

    expect(calculateTabDiff(previous, current)).toEqual({ added: [], closed: [] });
  });

  it('uses URL counts so duplicate tabs are not collapsed', () => {
    const previous = [
      saved('A first', 'https://a.example', 0),
      saved('A second', 'https://a.example', 1),
      saved('B', 'https://b.example', 2),
    ];
    const current = [
      { id: 11, title: 'A current', url: 'https://a.example', index: 0 },
      { id: 12, title: 'B', url: 'https://b.example', index: 1 },
    ];

    const diff = calculateTabDiff(previous, current);

    expect(diff.added).toEqual([]);
    expect(diff.closed).toEqual([{ kind: 'closed', ...previous[1] }]);
  });

  it('retains tab ids and positions for added tabs', () => {
    const diff = calculateTabDiff([], [
      { id: 42, title: 'Dashboard', url: 'https://app.example/path', favIconUrl: 'icon.png', index: 3 },
    ]);

    expect(diff.added[0]).toEqual({
      kind: 'added',
      title: 'Dashboard',
      url: 'https://app.example/path',
      favIconUrl: 'icon.png',
      position: 3,
      tabId: 42,
    });
  });

  it('recalculates after a closed tab is reopened', () => {
    const previous = [saved('A', 'https://a.example', 0), saved('B', 'https://b.example', 1)];
    const before = calculateTabDiff(previous, [{ id: 1, title: 'A', url: 'https://a.example', index: 0 }]);
    const after = calculateTabDiff(previous, [
      { id: 1, title: 'A', url: 'https://a.example', index: 0 },
      { id: 2, title: 'B', url: 'https://b.example', index: 1 },
    ]);

    expect(before.closed).toHaveLength(1);
    expect(after.closed).toHaveLength(0);
  });

  it('handles 15 added and 10 closed tabs without losing occurrences', () => {
    const previous = Array.from({ length: 10 }, (_, index) => saved(`Closed ${index}`, `https://closed-${index}.example`, index));
    const current = Array.from({ length: 15 }, (_, index) => ({ id: index, title: `Added ${index}`, url: `https://added-${index}.example`, index }));

    const diff = calculateTabDiff(previous, current);

    expect(diff.added).toHaveLength(15);
    expect(diff.closed).toHaveLength(10);
  });
});

describe('getTabDomain', () => {
  it('shows a compact hostname and supports browser URLs', () => {
    expect(getTabDomain('https://www.example.com/path')).toBe('example.com');
    expect(getTabDomain('chrome://extensions')).toBe('chrome');
    expect(getTabDomain('about:blank')).toBe('about:blank');
  });
});
