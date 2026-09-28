import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMock = vi.hoisted(() => ({
  windows: { get: vi.fn(), getAll: vi.fn(), remove: vi.fn(), create: vi.fn(), update: vi.fn() },
  tabs: { create: vi.fn(), remove: vi.fn(), update: vi.fn() },
  runtime: { sendMessage: vi.fn().mockResolvedValue(undefined), getURL: vi.fn((path: string) => `chrome-extension://test${path}`) },
}));
const bindingMock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
const logMock = vi.hoisted(() => ({ add: vi.fn() }));
const tombstoneMock = vi.hoisted(() => ({ add: vi.fn() }));
const workspaceMock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), saveContent: vi.fn(), put: vi.fn(), remove: vi.fn() }));
const syncMock = vi.hoisted(() => ({ syncAll: vi.fn() }));

vi.mock('wxt/browser', () => ({ browser: browserMock }));
vi.mock('@/lib/storage/bindingRepository', () => ({ bindingRepository: bindingMock }));
vi.mock('@/lib/storage/syncLogRepository', () => ({ syncLogRepository: logMock }));
vi.mock('@/lib/storage/tombstoneRepository', () => ({ tombstoneRepository: tombstoneMock }));
vi.mock('@/lib/storage/workspaceRepository', () => ({ workspaceRepository: workspaceMock }));
vi.mock('@/lib/sync/syncEngine', () => ({ syncEngine: syncMock }));

import {
  focusWindowTab,
  openOrFocusWorkspace,
  openWorkspaceTab,
  reopenSavedTab,
  resolveWorkspaceForWindow,
  restoreWorkspace,
  saveCurrentWindow,
} from '@/features/workspaces/workspaceService';
import type { WorkspaceLocalRecord } from '@/types/workspace';

const localRecord: WorkspaceLocalRecord = {
  content: {
    id: 'workspace-1', name: 'PetLifeHub', status: 'active', activeTabIndex: 1,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
    tabs: [
      { title: '第二页', url: 'https://b.example', position: 1, pinned: false },
      { title: '第一页', url: 'https://a.example', position: 0, pinned: true },
    ],
  },
  sync: {
    syncStatus: 'synced', lastSyncedAt: null, lastSyncedHash: 'hash',
    lastSyncedCloudUpdatedAt: null, localExpiresAt: '2026-10-24T00:00:00.000Z', lastSyncError: null,
  },
};

describe('workspaceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindingMock.get.mockResolvedValue(null);
    bindingMock.set.mockResolvedValue(undefined);
    logMock.add.mockResolvedValue(undefined);
    workspaceMock.saveContent.mockImplementation(async (content) => ({ ...localRecord, content }));
    workspaceMock.put.mockResolvedValue(undefined);
    workspaceMock.list.mockResolvedValue([]);
    browserMock.windows.getAll.mockResolvedValue([]);
    syncMock.syncAll.mockResolvedValue(undefined);
  });

  it('captures only the explicitly requested window and closes it after local persistence', async () => {
    browserMock.windows.get.mockResolvedValue({
      id: 22,
      tabs: [
        { id: 2, title: 'B2', url: 'https://b.example/2', index: 1, active: true, pinned: false },
        { id: 1, title: 'B1', url: 'https://b.example/1', index: 0, active: false, pinned: true },
      ],
    });
    browserMock.windows.remove.mockResolvedValue(undefined);

    const result = await saveCurrentWindow({ windowId: 22, name: '窗口 B', status: 'active', closeAfterSave: true });

    expect(browserMock.windows.get).toHaveBeenCalledWith(22, { populate: true });
    expect(result.tabs.map((tab) => tab.title)).toEqual(['B1', 'B2']);
    expect(result.activeTabIndex).toBe(1);
    expect(browserMock.windows.remove).toHaveBeenCalledWith(22);
    expect(workspaceMock.saveContent.mock.invocationCallOrder[0]).toBeLessThan(browserMock.windows.remove.mock.invocationCallOrder[0]!);
  });

  it('never closes the window when local persistence fails', async () => {
    browserMock.windows.get.mockResolvedValue({
      id: 22,
      tabs: [{ id: 1, title: 'B1', url: 'https://b.example', index: 0, active: true, pinned: false }],
    });
    workspaceMock.saveContent.mockRejectedValueOnce(new Error('Quota exceeded'));

    await expect(saveCurrentWindow({ windowId: 22, name: '窗口 B', status: 'active', closeAfterSave: true })).rejects.toThrow('Quota exceeded');
    expect(browserMock.windows.remove).not.toHaveBeenCalled();
  });

  it('restores ordered tabs, pinned state and active tab into a new window', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create
      .mockResolvedValueOnce({ id: 901 })
      .mockResolvedValueOnce({ id: 902 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);

    await restoreWorkspace('workspace-1');

    expect(browserMock.tabs.create.mock.calls.map(([input]) => input)).toEqual([
      { windowId: 99, url: 'https://a.example', active: false, pinned: true },
      { windowId: 99, url: 'https://b.example', active: false, pinned: false },
    ]);
    expect(browserMock.tabs.remove).toHaveBeenCalledWith(900);
    expect(browserMock.tabs.update).toHaveBeenCalledWith(902, { active: true });
    expect(bindingMock.set).toHaveBeenCalledWith(99, 'workspace-1');
  });

  it('opens one saved tab in the current browser window', async () => {
    browserMock.tabs.create.mockResolvedValue({ id: 903 });

    await openWorkspaceTab('https://example.com/article');

    expect(browserMock.tabs.create).toHaveBeenCalledOnce();
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/article', active: true });
  });

  it('activates an added tab and focuses its bound window', async () => {
    browserMock.tabs.update.mockResolvedValue({});
    browserMock.windows.update.mockResolvedValue({});

    await focusWindowTab(22, 42);

    expect(browserMock.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(browserMock.windows.update).toHaveBeenCalledWith(22, { focused: true });
  });

  it('reopens a closed tab in the same window at its saved position', async () => {
    browserMock.tabs.create.mockResolvedValue({ id: 43 });
    const tab = savedTab('Article', 'https://example.com/article', 3, true);

    await reopenSavedTab(22, tab);

    expect(browserMock.tabs.create).toHaveBeenCalledWith({
      windowId: 22,
      url: 'https://example.com/article',
      active: true,
      index: 3,
      pinned: true,
    });
  });

  it('rebuilds a runtime binding when Chrome assigns a different window id after restart', async () => {
    workspaceMock.list.mockResolvedValue([localRecord]);

    const result = await resolveWorkspaceForWindow(8675, [
      { url: 'https://a.example', index: 0, pinned: true },
      { url: 'https://b.example', index: 1, pinned: false },
    ]);

    expect(result).toBe(localRecord);
    expect(bindingMock.set).toHaveBeenCalledWith(8675, 'workspace-1');
  });

  it('keeps the existing runtime binding as the fast path', async () => {
    bindingMock.get.mockResolvedValue('workspace-1');
    workspaceMock.get.mockResolvedValue(localRecord);

    const result = await resolveWorkspaceForWindow(22, []);

    expect(result).toBe(localRecord);
    expect(workspaceMock.list).not.toHaveBeenCalled();
    expect(bindingMock.set).not.toHaveBeenCalled();
  });

  it('focuses an already bound workspace instead of restoring a duplicate', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.windows.getAll.mockResolvedValue([{ id: 22, tabs: [] }]);
    bindingMock.get.mockResolvedValue('workspace-1');
    browserMock.windows.update.mockResolvedValue({});

    await expect(openOrFocusWorkspace('workspace-1')).resolves.toBe(22);

    expect(browserMock.windows.update).toHaveBeenCalledWith(22, { focused: true });
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('re-identifies and binds an existing workspace before restoring', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.windows.getAll.mockResolvedValue([{ id: 33, tabs: [
      { url: 'https://a.example', index: 0, pinned: true },
      { url: 'https://b.example', index: 1, pinned: false },
      { url: 'chrome-extension://test/launcher.html?workspaceId=workspace-1', index: 2 },
    ] }]);
    browserMock.windows.update.mockResolvedValue({});

    await expect(openOrFocusWorkspace('workspace-1')).resolves.toBe(33);

    expect(bindingMock.set).toHaveBeenCalledWith(33, 'workspace-1');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it.each([
    { field: 'url', value: 'chrome-extension://test/launcher.html?workspaceId=workspace-1' },
    { field: 'pendingUrl', value: 'chrome-extension://test/launcher.html?workspaceId=workspace-1' },
  ])('filters a launcher tab from $field before matching', async ({ field, value }) => {
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.windows.getAll.mockResolvedValue([{ id: 34, tabs: [
      { url: 'https://a.example', index: 0, pinned: true },
      { url: 'https://b.example', index: 1, pinned: false },
      { [field]: value, index: 2 },
    ] }]);
    browserMock.windows.update.mockResolvedValue({});

    await expect(openOrFocusWorkspace('workspace-1')).resolves.toBe(34);

    expect(bindingMock.set).toHaveBeenCalledWith(34, 'workspace-1');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('rebinds the unique four-of-five window and does not restore', async () => {
    const record = fiveTabRecord();
    workspaceMock.get.mockResolvedValue(record);
    browserMock.windows.getAll.mockResolvedValue([
      { id: 40, tabs: currentTabs(['A', 'B', 'C', 'D', 'changed']) },
      { id: 41, tabs: currentTabs(['A', 'B', 'other-1', 'other-2', 'other-3']) },
    ]);
    browserMock.windows.update.mockResolvedValue({});

    await expect(openOrFocusWorkspace(record.content.id)).resolves.toBe(40);

    expect(bindingMock.set).toHaveBeenCalledWith(40, record.content.id);
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('does not bind a five-tab window with only three matches', async () => {
    const record = fiveTabRecord();
    workspaceMock.get.mockResolvedValue(record);
    browserMock.windows.getAll.mockResolvedValue([{ id: 40, tabs: currentTabs(['A', 'B', 'C', 'X', 'Y']) }]);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });

    await expect(openOrFocusWorkspace(record.content.id)).resolves.toBe(99);

    expect(bindingMock.set).not.toHaveBeenCalledWith(40, record.content.id);
  });

  it('stops when two existing windows are similarly strong candidates', async () => {
    const record = fiveTabRecord();
    workspaceMock.get.mockResolvedValue(record);
    browserMock.windows.getAll.mockResolvedValue([
      { id: 40, tabs: currentTabs(['A', 'B', 'C', 'D', 'changed-1']) },
      { id: 41, tabs: currentTabs(['A', 'B', 'C', 'D', 'changed-2']) },
    ]);

    await expect(openOrFocusWorkspace(record.content.id)).rejects.toThrow('多个相似');

    expect(bindingMock.set).not.toHaveBeenCalled();
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('shares one restore for concurrent launches of the same workspace', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.windows.getAll.mockResolvedValue([]);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });

    const results = await Promise.all([
      openOrFocusWorkspace('workspace-1'),
      openOrFocusWorkspace('workspace-1'),
    ]);

    expect(results).toEqual([99, 99]);
    expect(browserMock.windows.create).toHaveBeenCalledOnce();
  });

  it('restores only when no existing window matches', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValueOnce({ id: 901 }).mockResolvedValueOnce({ id: 902 });

    await expect(openOrFocusWorkspace('workspace-1')).resolves.toBe(99);

    expect(browserMock.windows.create).toHaveBeenCalledOnce();
  });
});

function savedTab(title: string, url: string, position: number, pinned: boolean) {
  return { title, url, position, pinned };
}

function fiveTabRecord(): WorkspaceLocalRecord {
  return {
    ...localRecord,
    content: {
      ...localRecord.content,
      id: 'workspace-five',
      tabs: ['A', 'B', 'C', 'D', 'E'].map((url, position) => savedTab(url, url, position, position === 0)),
    },
  };
}

function currentTabs(urls: string[]) {
  return urls.map((url, index) => ({ title: url, url, index, pinned: index === 0 }));
}
