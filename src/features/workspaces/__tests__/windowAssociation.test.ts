import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentWindowAssociation } from '@/lib/storage/windowAssociationRepository';
import type { WorkspaceLocalRecord } from '@/types/workspace';

const browserMock = vi.hoisted(() => ({
  windows: { get: vi.fn(), getAll: vi.fn(), create: vi.fn(), remove: vi.fn() },
}));
const bindings = vi.hoisted(() => new Map<number, string>());
const bindingMock = vi.hoisted(() => ({
  get: vi.fn(async (windowId: number) => bindings.get(windowId) ?? null),
  set: vi.fn(async (windowId: number, workspaceId: string) => { bindings.set(windowId, workspaceId); }),
  isSuppressed: vi.fn(async () => false),
}));
const associations = vi.hoisted(() => [] as PersistentWindowAssociation[]);
const associationMock = vi.hoisted(() => ({
  list: vi.fn(async () => associations),
  upsert: vi.fn(async (workspaceId: string, windowSnapshot: PersistentWindowAssociation['windowSnapshot']) => {
    const existing = associations.find((item) => item.workspaceId === workspaceId);
    const record = { associationId: existing?.associationId ?? `association-${workspaceId}`, workspaceId, windowSnapshot, lastObservedAt: '2026-10-09T00:00:00.000Z' };
    if (existing) associations.splice(associations.indexOf(existing), 1, record);
    else associations.push(record);
    return { record, created: !existing, changed: true };
  }),
}));
const workspaceMock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const logMock = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('wxt/browser', () => ({ browser: browserMock }));
vi.mock('@/lib/storage/bindingRepository', () => ({ bindingRepository: bindingMock }));
vi.mock('@/lib/storage/windowAssociationRepository', () => ({ windowAssociationRepository: associationMock }));
vi.mock('@/lib/storage/workspaceRepository', () => ({ workspaceRepository: workspaceMock }));
vi.mock('@/lib/storage/syncLogRepository', () => ({ syncLogRepository: logMock }));
vi.mock('@/features/workspaces/lazyRestore', () => ({ resolveLogicalTabs: vi.fn(async (tabs) => tabs) }));

import {
  associateExistingWorkspace,
  maintainWindowAssociations,
  refreshBoundWindowAssociation,
  restorePersistentWindowAssociations,
} from '../windowAssociation';

function tabs(urls: string[]) {
  return urls.map((url, index) => ({ id: index + 1, index, url, pinned: index === 0, active: index === 0 }));
}

function association(workspaceId: string, urls: string[]): PersistentWindowAssociation {
  return {
    associationId: `association-${workspaceId}`,
    workspaceId,
    windowSnapshot: {
      tabs: urls.map((url, position) => ({ url, position, pinned: position === 0 })),
      activeTabIndex: 0,
    },
    lastObservedAt: '2026-10-09T00:00:00.000Z',
  };
}

function workspace(id: string): WorkspaceLocalRecord {
  return {
    content: { id, name: id, status: 'active', tabs: [], activeTabIndex: 0, createdAt: '', updatedAt: '' },
    sync: { syncStatus: 'synced', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: '', lastSyncError: null },
  };
}

describe('persistent window association recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindings.clear();
    associations.splice(0);
    browserMock.windows.get.mockReset();
    browserMock.windows.getAll.mockResolvedValue([]);
    workspaceMock.list.mockResolvedValue([]);
    workspaceMock.get.mockResolvedValue(null);
  });

  it('restores 5 saved tabs plus 12 blank tabs after the window id changes', async () => {
    const urls = [...Array.from({ length: 5 }, (_, index) => `https://windowstash.dev/${index}`), ...Array(12).fill('about:blank')];
    associations.push(association('windowstash', urls));
    workspaceMock.list.mockResolvedValue([workspace('windowstash')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 99, tabs: tabs(urls) }]);

    await expect(restorePersistentWindowAssociations()).resolves.toBe(1);

    expect(bindings.get(99)).toBe('windowstash');
  });

  it('persists 5 plus 12 tabs before an immediate restart instead of waiting for an alarm', async () => {
    const saved = Array.from({ length: 5 }, (_, index) => `https://windowstash.dev/${index}`);
    const current = [...saved, ...Array(12).fill('about:blank')];
    associations.push(association('immediate', saved));
    bindings.set(22, 'immediate');
    browserMock.windows.get.mockResolvedValue({ id: 22, tabs: tabs(current) });

    await expect(Promise.all(Array.from({ length: 12 }, () => refreshBoundWindowAssociation(22))))
      .resolves.toEqual(Array(12).fill(true));
    expect(associations[0]!.windowSnapshot.tabs).toHaveLength(17);
    expect(associationMock.upsert.mock.calls.length).toBeLessThanOrEqual(2);

    bindings.clear();
    workspaceMock.list.mockResolvedValue([workspace('immediate')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 99, tabs: tabs(current) }]);
    await expect(restorePersistentWindowAssociations()).resolves.toBe(1);
    expect(bindings.get(99)).toBe('immediate');
  });

  it('keeps an event-written snapshot restorable after a later restart', async () => {
    const current = ['https://later.example/a', 'https://later.example/b', 'about:blank'];
    associations.push(association('later', current.slice(0, 2)));
    bindings.set(22, 'later');
    browserMock.windows.get.mockResolvedValue({ id: 22, tabs: tabs(current) });

    await refreshBoundWindowAssociation(22);
    bindings.clear();
    workspaceMock.list.mockResolvedValue([workspace('later')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 100, tabs: tabs(current) }]);

    await expect(restorePersistentWindowAssociations()).resolves.toBe(1);
    expect(bindings.get(100)).toBe('later');
  });

  it('persists a one-tab state before an immediate restart', async () => {
    const original = Array.from({ length: 5 }, (_, index) => `https://one.example/${index}`);
    associations.push(association('one', original));
    bindings.set(22, 'one');
    browserMock.windows.get.mockResolvedValue({ id: 22, tabs: tabs([original[0]!]) });

    await refreshBoundWindowAssociation(22);
    expect(associations[0]!.windowSnapshot.tabs).toHaveLength(1);

    bindings.clear();
    workspaceMock.list.mockResolvedValue([workspace('one')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 101, tabs: tabs([original[0]!]) }]);
    await expect(restorePersistentWindowAssociations()).resolves.toBe(1);
    expect(bindings.get(101)).toBe('one');
  });

  it('repairs a missed event write when a service worker starts again', async () => {
    const current = [...Array.from({ length: 5 }, (_, index) => `https://restart.example/${index}`), ...Array(12).fill('about:blank')];
    associations.push(association('worker-restart', current.slice(0, 5)));
    bindings.set(22, 'worker-restart');
    browserMock.windows.getAll.mockResolvedValue([{ id: 22, tabs: tabs(current) }]);

    await maintainWindowAssociations();

    expect(associations[0]!.windowSnapshot.tabs).toHaveLength(17);
  });

  it('updates two bound workspaces concurrently without mixing their snapshots', async () => {
    const first = ['https://first.example', 'about:blank'];
    const second = ['https://second.example', 'about:blank', 'about:blank'];
    associations.push(association('first', first.slice(0, 1)), association('second', second.slice(0, 1)));
    bindings.set(11, 'first');
    bindings.set(22, 'second');
    browserMock.windows.get.mockImplementation(async (windowId: number) => ({
      id: windowId,
      tabs: tabs(windowId === 11 ? first : second),
    }));

    await Promise.all([refreshBoundWindowAssociation(11), refreshBoundWindowAssociation(22)]);

    expect(associations.find((item) => item.workspaceId === 'first')!.windowSnapshot.tabs).toHaveLength(2);
    expect(associations.find((item) => item.workspaceId === 'second')!.windowSnapshot.tabs).toHaveLength(3);
  });

  it('restores a snapshot that contains only one distinctive original tab', async () => {
    associations.push(association('small', ['https://windowstash.dev/only']));
    workspaceMock.list.mockResolvedValue([workspace('small')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 87, tabs: tabs(['https://windowstash.dev/only']) }]);

    await expect(restorePersistentWindowAssociations()).resolves.toBe(1);
    expect(bindings.get(87)).toBe('small');
  });

  it('does not restore an all-blank snapshot without distinctive evidence', async () => {
    associations.push(association('blank', Array(5).fill('about:blank')));
    workspaceMock.list.mockResolvedValue([workspace('blank')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 44, tabs: tabs(Array(5).fill('about:blank')) }]);

    await expect(restorePersistentWindowAssociations()).resolves.toBe(0);
    expect(bindingMock.set).not.toHaveBeenCalled();
  });

  it('globally restores two differently sized workspaces to unique windows', async () => {
    const firefly = Array.from({ length: 41 }, (_, index) => `https://firefly.example/${index}`);
    const windowstash = [...Array.from({ length: 5 }, (_, index) => `https://windowstash.dev/${index}`), ...Array(12).fill('about:blank')];
    associations.push(association('firefly', firefly), association('windowstash', windowstash));
    workspaceMock.list.mockResolvedValue([workspace('firefly'), workspace('windowstash')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 81, tabs: tabs(windowstash) }, { id: 82, tabs: tabs(firefly) }]);

    await expect(restorePersistentWindowAssociations()).resolves.toBe(2);
    expect(bindings.get(81)).toBe('windowstash');
    expect(bindings.get(82)).toBe('firefly');
  });

  it('rejects two identical windows as ambiguous', async () => {
    const urls = ['https://same.example/a', 'https://same.example/b'];
    associations.push(association('same', urls));
    workspaceMock.list.mockResolvedValue([workspace('same')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 1, tabs: tabs(urls) }, { id: 2, tabs: tabs(urls) }]);

    await expect(restorePersistentWindowAssociations()).resolves.toBe(0);
    expect(bindingMock.set).not.toHaveBeenCalled();
    expect(logMock.add).toHaveBeenCalledWith(expect.objectContaining({ action: 'persistent-association-ambiguous' }));
  });

  it('keeps the association and succeeds when delayed tabs appear on a later pass', async () => {
    const urls = ['https://delayed.example/a', 'https://delayed.example/b', 'https://delayed.example/c'];
    associations.push(association('delayed', urls));
    workspaceMock.list.mockResolvedValue([workspace('delayed')]);
    browserMock.windows.getAll.mockResolvedValueOnce([{ id: 55, tabs: tabs(['https://delayed.example/a']) }]);

    await expect(restorePersistentWindowAssociations()).resolves.toBe(0);
    browserMock.windows.getAll.mockResolvedValueOnce([{ id: 55, tabs: tabs(urls) }]);
    await expect(restorePersistentWindowAssociations()).resolves.toBe(1);
    expect(bindings.get(55)).toBe('delayed');
  });

  it('refreshes the persistent snapshot after tabs are closed without dropping the live binding', async () => {
    bindings.set(31, 'bound');
    workspaceMock.list.mockResolvedValue([workspace('bound')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 31, tabs: tabs(['https://bound.example/remaining']) }]);

    await maintainWindowAssociations();

    expect(bindings.get(31)).toBe('bound');
    expect(associationMock.upsert).toHaveBeenCalledWith('bound', expect.objectContaining({
      tabs: [expect.objectContaining({ url: 'https://bound.example/remaining' })],
    }));
  });

  it('can retry after a transient local-storage read failure', async () => {
    associations.push(association('retry', ['https://retry.example']));
    workspaceMock.list.mockResolvedValue([workspace('retry')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 61, tabs: tabs(['https://retry.example']) }]);
    associationMock.list.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(restorePersistentWindowAssociations()).resolves.toBe(0);
    await expect(restorePersistentWindowAssociations()).resolves.toBe(1);
    expect(bindings.get(61)).toBe('retry');
  });

  it('manual association binds in place and blocks a workspace claimed by another window', async () => {
    workspaceMock.get.mockResolvedValue(workspace('manual'));
    browserMock.windows.getAll.mockResolvedValue([{ id: 10 }, { id: 20 }]);

    await associateExistingWorkspace(10, 'manual', tabs(['https://current.example']));
    expect(bindings.get(10)).toBe('manual');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
    expect(browserMock.windows.remove).not.toHaveBeenCalled();

    await expect(associateExistingWorkspace(20, 'manual', tabs(['https://other.example']))).rejects.toThrow('该工作区已关联另一个窗口');
    expect(bindings.get(20)).toBeUndefined();
  });

  it('never trusts a reused old numeric window id when its tabs do not match', async () => {
    associations.push(association('old', ['https://original.example']));
    workspaceMock.list.mockResolvedValue([workspace('old')]);
    browserMock.windows.getAll.mockResolvedValue([{ id: 7, tabs: tabs(['https://unrelated.example']) }]);

    await expect(restorePersistentWindowAssociations()).resolves.toBe(0);
    expect(bindings.get(7)).toBeUndefined();
  });
});
