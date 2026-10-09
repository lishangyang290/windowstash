import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMock = vi.hoisted(() => ({
  windows: { get: vi.fn(), getAll: vi.fn(), remove: vi.fn(), create: vi.fn(), update: vi.fn() },
  tabs: { create: vi.fn(), get: vi.fn(), remove: vi.fn(), update: vi.fn() },
  runtime: { sendMessage: vi.fn().mockResolvedValue(undefined), getURL: vi.fn((path: string) => `chrome-extension://test${path}`) },
}));
const bindingMock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), suppress: vi.fn(), isSuppressed: vi.fn(), remove: vi.fn() }));
const logMock = vi.hoisted(() => ({ add: vi.fn() }));
const tombstoneMock = vi.hoisted(() => ({ add: vi.fn() }));
const workspaceMock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), saveContent: vi.fn(), put: vi.fn(), remove: vi.fn() }));
const syncMock = vi.hoisted(() => ({ syncAll: vi.fn() }));
const lazyMock = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), put: vi.fn(), remove: vi.fn(), removeByTabId: vi.fn(), removeByWindowId: vi.fn(), removeMany: vi.fn(),
}));

vi.mock('wxt/browser', () => ({ browser: browserMock }));
vi.mock('@/lib/storage/bindingRepository', () => ({ bindingRepository: bindingMock }));
vi.mock('@/lib/storage/syncLogRepository', () => ({ syncLogRepository: logMock }));
vi.mock('@/lib/storage/tombstoneRepository', () => ({ tombstoneRepository: tombstoneMock }));
vi.mock('@/lib/storage/workspaceRepository', () => ({ workspaceRepository: workspaceMock }));
vi.mock('@/lib/sync/syncEngine', () => ({ syncEngine: syncMock }));
vi.mock('@/lib/storage/lazyRestoreRepository', () => ({ lazyRestoreRepository: lazyMock }));

import {
  focusWindowTab,
  openOrFocusWorkspace,
  openWorkspaceTab,
  recoverWorkspace,
  reopenSavedTab,
  reopenWorkspace,
  resolveWorkspaceForWindow,
  resolveWorkspaceStateForWindow,
  restoreSavedWorkspace,
  restoreWorkspace,
  saveCurrentWindow,
  updateWorkspace,
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
    bindingMock.suppress.mockResolvedValue(undefined);
    bindingMock.isSuppressed.mockResolvedValue(false);
    bindingMock.remove.mockResolvedValue(undefined);
    logMock.add.mockResolvedValue(undefined);
    workspaceMock.saveContent.mockImplementation(async (content) => ({ ...localRecord, content }));
    workspaceMock.put.mockResolvedValue(undefined);
    workspaceMock.list.mockResolvedValue([]);
    browserMock.runtime.sendMessage.mockResolvedValue(undefined);
    browserMock.windows.getAll.mockResolvedValue([]);
    syncMock.syncAll.mockResolvedValue(undefined);
    lazyMock.get.mockResolvedValue(null);
    lazyMock.put.mockResolvedValue(undefined);
    lazyMock.remove.mockResolvedValue(undefined);
    lazyMock.removeByWindowId.mockResolvedValue(undefined);
    lazyMock.removeMany.mockResolvedValue(undefined);
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

  it('renames locally and requests the existing workspace sync without changing its id', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);

    await updateWorkspace('workspace-1', { name: '新的工作区名称' });

    expect(workspaceMock.saveContent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workspace-1',
      name: '新的工作区名称',
    }));
    expect(browserMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'SYNC_WORKSPACE', workspaceId: 'workspace-1' });
  });

  it('keeps an offline rename successful after local persistence', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.runtime.sendMessage.mockRejectedValueOnce(new Error('offline'));

    await expect(updateWorkspace('workspace-1', { name: '离线新名称' })).resolves.toBeUndefined();

    expect(workspaceMock.saveContent).toHaveBeenCalledWith(expect.objectContaining({ name: '离线新名称' }));
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

  it('restores an explicitly selected workspace without inspecting current windows or saving content', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);

    await expect(restoreSavedWorkspace('workspace-1')).resolves.toBe(99);

    expect(browserMock.windows.getAll).not.toHaveBeenCalled();
    expect(workspaceMock.saveContent).not.toHaveBeenCalled();
    expect(browserMock.windows.remove).not.toHaveBeenCalledWith(22);
  });

  it('downloads a missing local workspace before an explicit saved restore', async () => {
    workspaceMock.get.mockResolvedValueOnce(null).mockResolvedValue(localRecord);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);

    await expect(restoreSavedWorkspace('workspace-1')).resolves.toBe(99);

    expect(syncMock.syncAll).toHaveBeenCalledOnce();
  });

  it('restores only active position 4 directly and lazily restores the other eligible tabs', async () => {
    const record = recordWithTabs(10, 4);
    workspaceMock.get.mockResolvedValue(record);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockImplementation(async () => ({ id: 901 + browserMock.tabs.create.mock.calls.length }));
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);

    await restoreWorkspace(record.content.id);

    const urls = browserMock.tabs.create.mock.calls.map(([input]) => input.url as string);
    expect(urls[4]).toBe('https://example.com/4');
    expect(urls.filter((url) => url.startsWith('chrome-extension://test/lazy-tab.html?id='))).toHaveLength(9);
    expect(lazyMock.put).toHaveBeenCalledTimes(18);
    expect(browserMock.tabs.update).toHaveBeenCalledWith(expect.any(Number), { active: true });
  });

  it('keeps title, favicon, position and pinned state in each lazy registry entry', async () => {
    const record = recordWithTabs(2, 1);
    record.content.tabs[0]!.pinned = true;
    workspaceMock.get.mockResolvedValue(record);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValueOnce({ id: 901 }).mockResolvedValueOnce({ id: 902 });

    await restoreWorkspace(record.content.id);

    expect(lazyMock.put).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId: record.content.id,
      originalUrl: 'https://example.com/0',
      title: 'Tab 0',
      favIconUrl: 'https://example.com/favicon-0.ico',
      position: 0,
      pinned: true,
    }));
    expect(browserMock.tabs.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ pinned: true }));
  });

  it.each([
    { title: '', favIconUrl: 'https://example.com/favicon.ico' },
    { title: 'Readable', favIconUrl: undefined },
    { title: 'Readable', favIconUrl: 'not-a-favicon' },
  ])('loads the real URL when lazy metadata is unreliable', async ({ title, favIconUrl }) => {
    const record = recordWithTabs(2, 1);
    Object.assign(record.content.tabs[0]!, { title, favIconUrl });
    workspaceMock.get.mockResolvedValue(record);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });

    await restoreWorkspace(record.content.id);

    expect(browserMock.tabs.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ url: 'https://example.com/0' }));
  });

  it('falls back to the real URL when lazy placeholder initialization fails', async () => {
    const record = recordWithTabs(2, 1);
    workspaceMock.get.mockResolvedValue(record);
    lazyMock.put.mockRejectedValueOnce(new Error('storage unavailable'));
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });

    await restoreWorkspace(record.content.id);

    expect(browserMock.tabs.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ url: 'https://example.com/0' }));
  });

  it('restores fifty tabs while loading only active and fallback tabs directly', async () => {
    const record = recordWithTabs(50, 17);
    delete record.content.tabs[3]!.favIconUrl;
    workspaceMock.get.mockResolvedValue(record);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });

    await restoreWorkspace(record.content.id);

    const urls = browserMock.tabs.create.mock.calls.map(([input]) => input.url as string);
    expect(urls.filter((url) => url.startsWith('https://'))).toEqual(['https://example.com/3', 'https://example.com/17']);
    expect(urls.filter((url) => url.includes('/lazy-tab.html?id='))).toHaveLength(48);
  });

  it('saves a lazy tab as its original page rather than the placeholder URL', async () => {
    const lazyUrl = 'chrome-extension://test/lazy-tab.html?id=lazy-1';
    browserMock.windows.get.mockResolvedValue({ id: 22, tabs: [{ id: 1, title: 'WindowStash', url: lazyUrl, index: 0, active: true, pinned: true }] });
    lazyMock.get.mockResolvedValue({
      id: 'lazy-1', workspaceId: 'workspace-1', originalUrl: 'https://real.example/doc', title: 'Real document',
      favIconUrl: 'https://real.example/favicon.ico', position: 0, pinned: true, createdAt: new Date().toISOString(),
    });

    const result = await saveCurrentWindow({ windowId: 22, name: '窗口 B', status: 'active', closeAfterSave: false });

    expect(result.tabs[0]).toEqual(expect.objectContaining({ url: 'https://real.example/doc', title: 'Real document', pinned: true }));
    expect(result.tabs[0]!.url).not.toContain('lazy-tab.html');
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

  it('does not run the matcher for a suppressed window', async () => {
    bindingMock.isSuppressed.mockResolvedValue(true);

    await expect(resolveWorkspaceStateForWindow(22, [
      { url: 'https://a.example', index: 0, pinned: true },
      { url: 'https://b.example', index: 1, pinned: false },
    ])).resolves.toEqual({ status: 'unbound', workspaceId: null, record: null, source: null });

    expect(workspaceMock.list).not.toHaveBeenCalled();
    expect(bindingMock.set).not.toHaveBeenCalled();
  });

  it('keeps the existing runtime binding as the fast path', async () => {
    bindingMock.get.mockResolvedValue('workspace-1');
    workspaceMock.get.mockResolvedValue(localRecord);

    const result = await resolveWorkspaceForWindow(22, []);

    expect(result).toBe(localRecord);
    expect(workspaceMock.list).not.toHaveBeenCalled();
    expect(bindingMock.set).not.toHaveBeenCalled();
  });

  it('keeps bound workspace identity when a lazy registry entry is missing', async () => {
    bindingMock.get.mockResolvedValue('workspace-1');
    workspaceMock.get.mockResolvedValue(localRecord);
    lazyMock.get.mockResolvedValue(null);

    await expect(resolveWorkspaceStateForWindow(22, [{
      url: 'chrome-extension://test/lazy-tab.html?id=missing', index: 0,
    }])).resolves.toEqual({ status: 'resolved', workspaceId: 'workspace-1', record: localRecord, source: 'binding' });
  });

  it('reports unresolved identity instead of guessing when an unbound lazy entry is missing', async () => {
    lazyMock.get.mockResolvedValue(null);

    await expect(resolveWorkspaceStateForWindow(22, [{
      url: 'chrome-extension://test/lazy-tab.html?id=missing', index: 0,
    }])).resolves.toEqual({ status: 'unresolved', workspaceId: null, record: null, source: null });

    expect(bindingMock.set).not.toHaveBeenCalled();
  });

  it.each([
    ['twenty added tabs', Array.from({ length: 22 }, (_, index) => ({ url: `https://current.example/${index}`, index }))],
    ['most tabs removed', [{ url: 'https://a.example', index: 0 }]],
    ['every URL changed', [
      { url: 'https://changed.example/one', index: 0 },
      { url: 'https://changed.example/two', index: 1 },
    ]],
  ])('keeps a valid binding without running the matcher when %s', async (_case, tabs) => {
    bindingMock.get.mockResolvedValue('workspace-1');
    workspaceMock.get.mockResolvedValue(localRecord);

    const result = await resolveWorkspaceStateForWindow(22, tabs);

    expect(result).toEqual({ status: 'resolved', workspaceId: 'workspace-1', record: localRecord, source: 'binding' });
    expect(workspaceMock.list).not.toHaveBeenCalled();
    expect(bindingMock.set).not.toHaveBeenCalled();
  });

  it('keeps bound identity when local workspace data cannot be restored', async () => {
    bindingMock.get.mockResolvedValue('workspace-1');
    workspaceMock.get.mockResolvedValue(null);

    const result = await resolveWorkspaceStateForWindow(22, []);

    expect(result).toEqual({ status: 'unavailable', workspaceId: 'workspace-1', record: null, source: 'binding' });
    expect(syncMock.syncAll).toHaveBeenCalledOnce();
    expect(workspaceMock.list).not.toHaveBeenCalled();
  });

  it('does not create a new workspace when bound local data is temporarily unavailable', async () => {
    bindingMock.get.mockResolvedValue('workspace-1');
    workspaceMock.get.mockResolvedValue(null);
    browserMock.windows.get.mockResolvedValue({
      id: 22,
      tabs: [{ id: 1, title: 'Current', url: 'https://current.example', index: 0, active: true, pinned: false }],
    });

    await expect(saveCurrentWindow({ windowId: 22, name: 'Workspace', status: 'active', closeAfterSave: false }))
      .rejects.toThrow('暂时无法读取此工作区');

    expect(syncMock.syncAll).toHaveBeenCalledOnce();
    expect(workspaceMock.saveContent).not.toHaveBeenCalled();
    expect(bindingMock.set).not.toHaveBeenCalled();
  });

  it('keeps the bound workspace id after recovering its missing local record', async () => {
    bindingMock.get.mockResolvedValue('workspace-1');
    workspaceMock.get.mockResolvedValueOnce(null).mockResolvedValue(localRecord);
    browserMock.windows.get.mockResolvedValue({
      id: 22,
      tabs: [{ id: 1, title: 'Current', url: 'https://current.example', index: 0, active: true, pinned: false }],
    });

    const result = await saveCurrentWindow({ windowId: 22, name: 'Workspace', status: 'active', closeAfterSave: false });

    expect(result.id).toBe('workspace-1');
    expect(syncMock.syncAll).toHaveBeenCalledOnce();
    expect(workspaceMock.saveContent).toHaveBeenCalledWith(expect.objectContaining({ id: 'workspace-1' }));
  });

  it('exposes the binding while a large lazy restore is still in progress', async () => {
    const record = recordWithTabs(20, 19);
    let boundId: string | null = null;
    let releaseFirstTab!: (value: { id: number }) => void;
    const firstTab = new Promise<{ id: number }>((resolve) => { releaseFirstTab = resolve; });
    workspaceMock.get.mockResolvedValue(record);
    bindingMock.set.mockImplementation(async (_windowId, workspaceId) => { boundId = workspaceId; });
    bindingMock.get.mockImplementation(async () => boundId);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 902 }).mockImplementationOnce(() => firstTab);
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);

    const restoring = restoreWorkspace(record.content.id);
    await vi.waitFor(() => expect(browserMock.tabs.create).toHaveBeenCalledOnce());

    await expect(resolveWorkspaceStateForWindow(99, [])).resolves.toEqual({
      status: 'resolved', workspaceId: record.content.id, record, source: 'binding',
    });
    expect(workspaceMock.list).not.toHaveBeenCalled();

    releaseFirstTab({ id: 901 });
    await restoring;
  });

  it('removes the early binding when the whole restore fails', async () => {
    const record = recordWithTabs(1, 0);
    workspaceMock.get.mockResolvedValue(record);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockRejectedValue(new Error('cannot create tab'));

    await expect(restoreWorkspace(record.content.id)).rejects.toThrow('Workspace 标签页恢复失败');

    expect(bindingMock.set).toHaveBeenCalledWith(99, record.content.id);
    expect(bindingMock.remove).toHaveBeenCalledWith(99);
  });

  it('reopens from saved data and transfers the authoritative binding only after restore', async () => {
    const record = recordWithTabs(3, 1);
    workspaceMock.get.mockResolvedValue(record);
    bindingMock.get.mockImplementation(async (windowId: number) => windowId === 22 ? record.content.id : null);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockImplementation(async () => ({ id: 901 + browserMock.tabs.create.mock.calls.length }));
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);
    browserMock.windows.remove.mockResolvedValue(undefined);

    await expect(reopenWorkspace(record.content.id, 22)).resolves.toBe(99);

    expect(browserMock.windows.get).not.toHaveBeenCalled();
    expect(workspaceMock.saveContent).not.toHaveBeenCalled();
    expect(workspaceMock.put).toHaveBeenCalledWith(expect.objectContaining({ content: record.content }));
    expect(browserMock.runtime.sendMessage).not.toHaveBeenCalled();
    expect(browserMock.windows.create).toHaveBeenCalledWith({ url: 'about:blank', focused: true });
    expect(bindingMock.suppress).toHaveBeenNthCalledWith(1, 99);
    expect(bindingMock.suppress).toHaveBeenNthCalledWith(2, 22);
    expect(bindingMock.set).toHaveBeenCalledWith(99, record.content.id);
    expect(bindingMock.suppress.mock.invocationCallOrder[1]).toBeGreaterThan(browserMock.tabs.update.mock.invocationCallOrder[0]!);
    expect(bindingMock.suppress.mock.invocationCallOrder[1]).toBeLessThan(bindingMock.set.mock.invocationCallOrder[0]!);
    expect(browserMock.windows.remove).toHaveBeenCalledWith(22);
    expect(bindingMock.set.mock.invocationCallOrder[0]).toBeLessThan(browserMock.windows.remove.mock.invocationCallOrder[0]!);
    expect(browserMock.windows.update).not.toHaveBeenCalledWith(22, { focused: true });
  });

  it('keeps the source binding while the reopened window is still restoring', async () => {
    const record = recordWithTabs(2, 1);
    let releaseFirstTab!: () => void;
    const firstTab = new Promise<{ id: number }>((resolve) => { releaseFirstTab = () => resolve({ id: 901 }); });
    workspaceMock.get.mockResolvedValue(record);
    bindingMock.get.mockImplementation(async (windowId: number) => windowId === 22 ? record.content.id : null);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockReturnValueOnce(firstTab).mockResolvedValue({ id: 902 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);
    browserMock.windows.update.mockResolvedValue(undefined);

    const reopening = reopenWorkspace(record.content.id, 22);
    await vi.waitFor(() => expect(browserMock.tabs.create).toHaveBeenCalledOnce());

    expect(browserMock.windows.create).toHaveBeenCalledWith({ url: 'about:blank', focused: true });
    expect(browserMock.windows.create.mock.invocationCallOrder[0]).toBeLessThan(browserMock.tabs.create.mock.invocationCallOrder[0]!);
    expect(bindingMock.suppress).toHaveBeenCalledWith(99);
    expect(bindingMock.suppress).not.toHaveBeenCalledWith(22);
    expect(bindingMock.set).not.toHaveBeenCalledWith(99, record.content.id);
    expect(browserMock.windows.remove).not.toHaveBeenCalledWith(22);

    releaseFirstTab();
    await reopening;
    expect(bindingMock.suppress).toHaveBeenCalledWith(22);
    expect(browserMock.windows.remove).toHaveBeenCalledWith(22);
  });

  it('keeps the source binding and removes a failed reopened window with its lazy registry', async () => {
    const record = recordWithTabs(2, 1);
    workspaceMock.get.mockResolvedValue(record);
    workspaceMock.put.mockRejectedValueOnce(new Error('metadata write failed'));
    bindingMock.get.mockImplementation(async (windowId: number) => windowId === 22 ? record.content.id : null);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValueOnce({ id: 901 }).mockResolvedValueOnce({ id: 902 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);
    browserMock.windows.remove.mockResolvedValue(undefined);

    await expect(reopenWorkspace(record.content.id, 22)).rejects.toThrow('metadata write failed');

    expect(bindingMock.suppress).toHaveBeenCalledWith(99);
    expect(bindingMock.suppress).not.toHaveBeenCalledWith(22);
    expect(bindingMock.set).not.toHaveBeenCalledWith(99, record.content.id);
    expect(bindingMock.remove).toHaveBeenCalledWith(99);
    expect(lazyMock.removeMany).toHaveBeenCalledWith(expect.arrayContaining([expect.any(String)]));
    expect(browserMock.windows.remove).toHaveBeenCalledWith(99);
    expect(browserMock.windows.remove).not.toHaveBeenCalledWith(22);
    expect(browserMock.windows.update).toHaveBeenCalledWith(22, { focused: true });
  });

  it('closes the reopened window when its binding cannot be created', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    bindingMock.get.mockResolvedValue('workspace-1');
    bindingMock.set.mockImplementation(async (windowId: number) => {
      if (windowId === 99) throw new Error('binding failed');
    });
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);
    browserMock.windows.remove.mockResolvedValue(undefined);

    await expect(reopenWorkspace('workspace-1', 22)).rejects.toThrow('binding failed');

    expect(bindingMock.remove).toHaveBeenCalledWith(99);
    expect(lazyMock.removeByWindowId).not.toHaveBeenCalled();
    expect(browserMock.windows.remove).toHaveBeenCalledWith(99);
    expect(bindingMock.suppress).toHaveBeenCalledWith(22);
    expect(bindingMock.set).toHaveBeenCalledWith(22, 'workspace-1');
    expect(browserMock.windows.update).toHaveBeenCalledWith(22, { focused: true });
  });

  it('restores the source binding when suppression fails during transfer', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    bindingMock.get.mockResolvedValue('workspace-1');
    bindingMock.suppress.mockImplementation(async (windowId: number) => {
      if (windowId === 22) throw new Error('suppression failed');
    });
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);
    browserMock.windows.remove.mockResolvedValue(undefined);

    await expect(reopenWorkspace('workspace-1', 22)).rejects.toThrow('suppression failed');

    expect(bindingMock.set).toHaveBeenCalledWith(22, 'workspace-1');
    expect(bindingMock.remove).toHaveBeenCalledWith(99);
    expect(browserMock.windows.remove).toHaveBeenCalledWith(99);
    expect(browserMock.windows.update).toHaveBeenCalledWith(22, { focused: true });
  });

  it('keeps the restored window authoritative when closing the source window fails', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    bindingMock.get.mockResolvedValue('workspace-1');
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);
    browserMock.windows.remove.mockRejectedValueOnce(new Error('close failed'));
    browserMock.windows.update.mockResolvedValue(undefined);

    await expect(reopenWorkspace('workspace-1', 22)).resolves.toBe(99);

    expect(bindingMock.suppress).toHaveBeenCalledWith(22);
    expect(bindingMock.set).toHaveBeenCalledWith(99, 'workspace-1');
    expect(bindingMock.remove).not.toHaveBeenCalledWith(99);
    expect(browserMock.windows.update).toHaveBeenCalledWith(99, { focused: true });
  });

  it('rejects reopening when the source window is not bound to the workspace', async () => {
    bindingMock.get.mockResolvedValue(null);

    await expect(reopenWorkspace('workspace-1', 22)).rejects.toThrow('当前窗口未绑定此工作区');

    expect(workspaceMock.get).not.toHaveBeenCalled();
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('recovers from saved content while preserving and suppressing the damaged source window', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    bindingMock.get.mockImplementation(async (windowId: number) => windowId === 22 ? 'workspace-1' : null);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockResolvedValue({ id: 901 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);

    await expect(recoverWorkspace('workspace-1', 22)).resolves.toBe(99);

    expect(bindingMock.suppress).toHaveBeenCalledWith(22);
    expect(bindingMock.set).toHaveBeenCalledWith(99, 'workspace-1');
    expect(browserMock.windows.remove).not.toHaveBeenCalledWith(22);
    expect(workspaceMock.saveContent).not.toHaveBeenCalled();
    expect(browserMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'SYNC_WORKSPACE' }));
  });

  it('leaves the damaged source untouched when recovery fails', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    bindingMock.get.mockImplementation(async (windowId: number) => windowId === 22 ? 'workspace-1' : null);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockRejectedValue(new Error('cannot create tab'));
    browserMock.windows.remove.mockResolvedValue(undefined);

    await expect(recoverWorkspace('workspace-1', 22)).rejects.toThrow('Workspace 标签页恢复失败');

    expect(bindingMock.suppress).not.toHaveBeenCalledWith(22);
    expect(browserMock.windows.remove).not.toHaveBeenCalledWith(22);
  });

  it('deduplicates concurrent reopen requests for the same source and workspace', async () => {
    let releaseFirstTab!: () => void;
    const firstTab = new Promise<{ id: number }>((resolve) => { releaseFirstTab = () => resolve({ id: 901 }); });
    workspaceMock.get.mockResolvedValue(localRecord);
    bindingMock.get.mockImplementation(async (windowId: number) => windowId === 22 ? 'workspace-1' : null);
    browserMock.windows.create.mockResolvedValue({ id: 99, tabs: [{ id: 900 }] });
    browserMock.tabs.create.mockReturnValueOnce(firstTab).mockResolvedValue({ id: 902 });
    browserMock.tabs.remove.mockResolvedValue(undefined);
    browserMock.tabs.update.mockResolvedValue(undefined);
    browserMock.windows.update.mockResolvedValue(undefined);

    const first = reopenWorkspace('workspace-1', 22);
    const second = reopenWorkspace('workspace-1', 22);
    await vi.waitFor(() => expect(browserMock.tabs.create).toHaveBeenCalledOnce());
    releaseFirstTab();

    await expect(Promise.all([first, second])).resolves.toEqual([99, 99]);
    expect(browserMock.windows.create).toHaveBeenCalledOnce();
  });

  it('creates a new workspace when the suppressed old window is explicitly saved', async () => {
    bindingMock.get.mockResolvedValue(null);
    bindingMock.isSuppressed.mockResolvedValue(true);
    browserMock.windows.get.mockResolvedValue({
      id: 22,
      tabs: [{ id: 1, title: 'Old state', url: 'https://old.example', index: 0, active: true, pinned: false }],
    });

    const saved = await saveCurrentWindow({ windowId: 22, name: '旧窗口副本', status: 'active', closeAfterSave: false });

    expect(saved.id).not.toBe('workspace-1');
    expect(bindingMock.set).toHaveBeenCalledWith(22, saved.id);
    expect(workspaceMock.saveContent).toHaveBeenCalledWith(expect.objectContaining({ id: saved.id }));
  });

  it('continues updating the original workspace when the reopened window is saved', async () => {
    bindingMock.get.mockResolvedValue('workspace-1');
    workspaceMock.get.mockResolvedValue(localRecord);
    browserMock.windows.get.mockResolvedValue({
      id: 99,
      tabs: [{ id: 1, title: 'New state', url: 'https://new.example', index: 0, active: true, pinned: false }],
    });

    const saved = await saveCurrentWindow({ windowId: 99, name: 'PetLifeHub', status: 'active', closeAfterSave: false });

    expect(saved.id).toBe('workspace-1');
    expect(workspaceMock.saveContent).toHaveBeenCalledWith(expect.objectContaining({ id: 'workspace-1' }));
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

  it('isolates an unrelated window with a missing lazy entry while opening a healthy workspace', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    lazyMock.get.mockResolvedValue(null);
    browserMock.windows.getAll.mockResolvedValue([
      { id: 31, tabs: [{ url: 'chrome-extension://test/lazy-tab.html?id=missing', index: 0 }] },
      { id: 32, tabs: [
        { url: 'https://a.example', index: 0, pinned: true },
        { url: 'https://b.example', index: 1, pinned: false },
      ] },
    ]);
    browserMock.windows.update.mockResolvedValue({});

    await expect(openOrFocusWorkspace('workspace-1')).resolves.toBe(32);

    expect(bindingMock.set).toHaveBeenCalledWith(32, 'workspace-1');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('matches a restored window through lazy tabs using their original URLs', async () => {
    workspaceMock.get.mockResolvedValue(localRecord);
    lazyMock.get.mockImplementation(async (id) => id === 'lazy-a' ? {
      id, workspaceId: 'workspace-1', originalUrl: 'https://a.example', title: '第一页',
      favIconUrl: 'https://a.example/favicon.ico', position: 0, pinned: true, createdAt: new Date().toISOString(),
    } : null);
    browserMock.windows.getAll.mockResolvedValue([{ id: 35, tabs: [
      { url: 'chrome-extension://test/lazy-tab.html?id=lazy-a', index: 0, pinned: true },
      { url: 'https://b.example', index: 1, pinned: false },
    ] }]);
    browserMock.windows.update.mockResolvedValue({});

    await expect(openOrFocusWorkspace('workspace-1')).resolves.toBe(35);

    expect(bindingMock.set).toHaveBeenCalledWith(35, 'workspace-1');
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

function recordWithTabs(count: number, activeTabIndex: number): WorkspaceLocalRecord {
  return {
    ...localRecord,
    content: {
      ...localRecord.content,
      id: `workspace-${count}`,
      activeTabIndex,
      tabs: Array.from({ length: count }, (_, position) => ({
        title: `Tab ${position}`,
        url: `https://example.com/${position}`,
        favIconUrl: `https://example.com/favicon-${position}.ico`,
        position,
        pinned: position < 2,
      })),
    },
  };
}
