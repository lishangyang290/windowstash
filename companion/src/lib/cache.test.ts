import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceSummary } from '../types';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
}, configurable: true });

import { accountOwner, cache, sortByRecent } from './cache';

const items: WorkspaceSummary[] = [
  { id: 'old', name: 'Old', tabCount: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'new', name: 'New', tabCount: 2, updatedAt: '2026-02-01T00:00:00.000Z' },
];

beforeEach(() => { storage.clear(); cache.scope('signed-out'); });
describe('companion cache', () => {

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

  it('persists Supabase config locally across reloads', () => {
    cache.saveSupabaseConfig({ url: 'https://project.supabase.co', publishableKey: 'publishable-key' });
    expect(cache.supabaseConfig()).toEqual({ url: 'https://project.supabase.co', publishableKey: 'publishable-key' });
  });
});

it.each([['https://one.supabase.co', 'B'], ['https://two.supabase.co', 'A']])('preserves cache and recents across account/project round trip %s/%s', (url, user) => {
  const a = accountOwner('https://one.supabase.co', 'A');
  const b = accountOwner(url, user);
  cache.scope(a); cache.saveWorkspaces(items); cache.markOpened('old');
  cache.scope(b);
  expect(cache.workspaces()).toEqual([]); expect(cache.recents()).toEqual({});
  cache.saveWorkspaces([{ ...items[0], name: 'B' }]);
  cache.scope(a);
  expect(cache.workspaces()).toEqual(items); expect(cache.recents().old).toBeTruthy();
  cache.scope(b); expect(cache.workspaces()[0].name).toBe('B');
});
it('migrates legacy cache only for a known previous login, retaining the original copy', () => {
  storage.set('windowstash-companion:workspaces:v1', JSON.stringify(items));
  const a = accountOwner('https://one.supabase.co', 'A');
  cache.scope(a, true);
  expect(cache.workspaces()).toEqual(items);
  cache.scope(accountOwner('https://one.supabase.co', 'B'), true);
  expect(cache.workspaces()).toEqual([]);
  expect(storage.get('windowstash-companion:workspaces:v1')).toBe(JSON.stringify(items));
});

it('merges known legacy cache and recents without overwriting current records or resurrecting removed entries', () => {
  const owner = accountOwner('https://one.supabase.co', 'A');
  storage.set('windowstash-companion:workspaces:v1', JSON.stringify(items));
  storage.set('windowstash-companion:recent:v1', JSON.stringify({ old: '2026-01-01' }));
  cache.scope(owner); cache.saveWorkspaces([{ ...items[1], name: 'newer cache' }]);
  cache.scope(owner, true);
  expect(cache.workspaces()).toHaveLength(2);
  expect(cache.workspaces().find((item) => item.id === 'new')?.name).toBe('newer cache');
  expect(cache.recents().old).toBe('2026-01-01');
  cache.saveWorkspaces([]); cache.scope(owner, true);
  expect(cache.workspaces()).toEqual([]);
});
