import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceSummary } from '../types';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });

import { cache, sortByRecent } from './cache';

const items: WorkspaceSummary[] = [
  { id: 'old', name: 'Old', tabCount: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'new', name: 'New', tabCount: 2, updatedAt: '2026-02-01T00:00:00.000Z' },
];

describe('companion cache', () => {
  beforeEach(() => storage.clear());

  it('returns cached workspaces immediately', () => {
    cache.saveWorkspaces(items);
    expect(cache.workspaces()).toEqual(items);
  });

  it('sorts unopened workspaces by cloud update time', () => {
    expect(sortByRecent(items).map((item) => item.id)).toEqual(['new', 'old']);
  });

  it('moves a locally opened workspace ahead of cloud order', () => {
    cache.markOpened('old');
    expect(sortByRecent(items).map((item) => item.id)).toEqual(['old', 'new']);
  });

  it('persists and clears a discovered extension id', () => {
    cache.saveExtensionId('abcdefghijklmnopabcdefghijklmnop');
    expect(cache.extensionId()).toBe('abcdefghijklmnopabcdefghijklmnop');
    cache.clearExtensionId();
    expect(cache.extensionId()).toBeNull();
  });
});
