import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = vi.hoisted(() => ({
  onMessage: undefined as ((message: unknown, sender: unknown) => unknown) | undefined,
  onInstalled: undefined as (() => void) | undefined,
  onStartup: undefined as (() => void) | undefined,
  onAlarm: undefined as ((alarm: { name: string }) => void) | undefined,
  onCreated: undefined as ((tab: { windowId: number }) => void) | undefined,
  onRemoved: undefined as ((tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void) | undefined,
  onMoved: undefined as ((tabId: number, info: { windowId: number }) => void) | undefined,
  onUpdated: undefined as ((tabId: number, info: { url?: string; title?: string }, tab: { windowId: number; url?: string }) => void) | undefined,
}));
const accessMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/authService', () => ({ authService: { requireSession: accessMock } }));
const reopenMock = vi.hoisted(() => vi.fn());
const recoverMock = vi.hoisted(() => vi.fn());
const restoreSavedMock = vi.hoisted(() => vi.fn());
const refreshAssociationMock = vi.hoisted(() => vi.fn());
const pendingSyncMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/sync/pendingSync', () => ({ PENDING_SYNC_ALARM: 'windowstash-pending-sync', syncPendingWorkspaces: pendingSyncMock }));

const browserMock = vi.hoisted(() => {
  const event = () => ({ addListener: vi.fn() });
  return {
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn((listener) => { listeners.onAlarm = listener; }) } },
    runtime: {
      onInstalled: { addListener: vi.fn((listener) => { listeners.onInstalled = listener; }) },
      onStartup: { addListener: vi.fn((listener) => { listeners.onStartup = listener; }) },
      onMessage: { addListener: vi.fn((listener) => { listeners.onMessage = listener; }) },
    },
    windows: { onRemoved: event() },
    tabs: {
      onActivated: event(),
      onCreated: { addListener: vi.fn((listener) => { listeners.onCreated = listener; }) },
      onUpdated: { addListener: vi.fn((listener) => { listeners.onUpdated = listener; }) },
      onRemoved: { addListener: vi.fn((listener) => { listeners.onRemoved = listener; }) },
      onMoved: { addListener: vi.fn((listener) => { listeners.onMoved = listener; }) },
      onAttached: event(), onDetached: event(),
    },
  };
});

vi.mock('wxt/browser', () => ({ browser: browserMock }));
vi.mock('@/features/workspaces/workspaceService', () => ({
  openOrFocusWorkspace: vi.fn(),
  recoverWorkspace: recoverMock,
  reopenWorkspace: reopenMock,
  restoreSavedWorkspace: restoreSavedMock,
}));
vi.mock('@/lib/sync/syncEngine', () => ({ syncEngine: { syncAll: vi.fn(), syncWorkspace: vi.fn(), cleanupExpiredLocalCopies: vi.fn() } }));
vi.mock('@/lib/storage/bindingRepository', () => ({ bindingRepository: { remove: vi.fn() } }));
vi.mock('@/features/workspaces/lazyRestore', () => ({
  beginStartupLazyReconciliation: vi.fn().mockResolvedValue(undefined),
  claimLazyTabFromBrowserTab: vi.fn(),
  cleanupOrphanedLazyEntries: vi.fn(),
  confirmLazyNavigation: vi.fn(),
  finishStartupLazyReconciliation: vi.fn(),
  handleLazyTabReady: vi.fn(),
  hydrateStartupLazyTab: vi.fn().mockResolvedValue(false),
  hydrateStartupLazyTabs: vi.fn(),
  isStartupLazyReconciliationActive: vi.fn().mockResolvedValue(false),
  isStartupLazyReconciliationComplete: vi.fn(),
  noteStartupLazyActivity: vi.fn().mockResolvedValue(undefined),
  removeLazyTab: vi.fn().mockResolvedValue(undefined),
  resolveLazyTab: vi.fn(),
}));
vi.mock('@/features/workspaces/windowAssociation', () => ({
  maintainWindowAssociations: vi.fn(),
  refreshBoundWindowAssociation: refreshAssociationMock,
  restorePersistentWindowAssociations: vi.fn(),
}));

beforeAll(async () => {
  vi.stubGlobal('defineBackground', (setup: () => void) => setup());
  await import('@/entrypoints/background');
});

describe('background messages', () => {
  it('drains the durable queue from an alarm without a popup or manager sender', async () => {
    listeners.onAlarm?.({ name: 'windowstash-pending-sync' });
    expect(pendingSyncMock).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    refreshAssociationMock.mockResolvedValue(true);
    accessMock.mockResolvedValue({ user: { id: 'A' } });
  });

  it('rehydrates lazy placeholders at browser startup before maintenance', async () => {
    const lazy = await import('@/features/workspaces/lazyRestore');
    listeners.onStartup?.();
    await vi.waitFor(() => expect(lazy.hydrateStartupLazyTabs).toHaveBeenCalledOnce());
    expect(lazy.beginStartupLazyReconciliation).toHaveBeenCalledOnce();
    expect(vi.mocked(lazy.beginStartupLazyReconciliation).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(lazy.hydrateStartupLazyTabs).mock.invocationCallOrder[0]!);
    expect(browserMock.alarms.create).toHaveBeenCalledWith('windowstash-window-association', expect.anything());
  });

  it('starts persistence directly for tab creation, removal and movement', () => {
    listeners.onCreated?.({ windowId: 11 });
    listeners.onRemoved?.(1, { windowId: 22, isWindowClosing: false });
    listeners.onMoved?.(2, { windowId: 33 });

    expect(refreshAssociationMock.mock.calls.map(([windowId]) => windowId)).toEqual([11, 22, 33]);
  });

  it('runs the complete reopen flow in background', async () => {
    reopenMock.mockResolvedValue(99);

    await expect(listeners.onMessage?.({
      type: 'REOPEN_WORKSPACE',
      workspaceId: 'workspace-1',
      sourceWindowId: 22,
    }, {})).resolves.toBe(99);

    expect(reopenMock).toHaveBeenCalledWith('workspace-1', 22);
  });

  it('runs the safe recovery flow in background', async () => {
    recoverMock.mockResolvedValue(99);

    await expect(listeners.onMessage?.({
      type: 'RECOVER_WORKSPACE',
      workspaceId: 'workspace-1',
      sourceWindowId: 22,
    }, {})).resolves.toBe(99);

    expect(recoverMock).toHaveBeenCalledWith('workspace-1', 22);
  });

  it('restores an explicitly selected saved workspace without a source window', async () => {
    restoreSavedMock.mockResolvedValue(99);

    await expect(listeners.onMessage?.({
      type: 'RESTORE_SAVED_WORKSPACE',
      workspaceId: 'workspace-1',
    }, {})).resolves.toBe(99);

    expect(restoreSavedMock).toHaveBeenCalledWith('workspace-1');
  });
});


it('blocks manager operations in background after logout', async () => {
  accessMock.mockRejectedValue(new Error('请先登录 WindowStash'));
  await expect(listeners.onMessage?.({ type: 'RESTORE_SAVED_WORKSPACE', workspaceId: 'A' }, { url: 'chrome-extension://fixture/options.html?recover=1' })).rejects.toThrow('请先登录');
  expect(restoreSavedMock).not.toHaveBeenCalledWith('A');
});

it('allows authenticated manager operations', async () => {
  accessMock.mockResolvedValue({ user: { id: 'A' } });
  restoreSavedMock.mockResolvedValue(99);
  await expect(listeners.onMessage?.({ type: 'RESTORE_SAVED_WORKSPACE', workspaceId: 'A' }, { url: 'chrome-extension://fixture/options.html' })).resolves.toBe(99);
  expect(restoreSavedMock).toHaveBeenCalledWith('A');
});

it.each(['REOPEN_WORKSPACE', 'RECOVER_WORKSPACE', 'RESTORE_SAVED_WORKSPACE', 'OPEN_OR_FOCUS_WORKSPACE', 'SYNC_WORKSPACE', 'SYNC_ALL'])('blocks %s from popup or other senders after logout', async (type) => {
  vi.clearAllMocks();
  accessMock.mockRejectedValue(new Error('请先登录 WindowStash'));
  await expect(listeners.onMessage?.({ type, workspaceId: 'A', sourceWindowId: 22 }, { url: 'chrome-extension://fixture/popup.html' })).rejects.toThrow('请先登录');
  expect(reopenMock).not.toHaveBeenCalled();
  expect(recoverMock).not.toHaveBeenCalled();
  expect(restoreSavedMock).not.toHaveBeenCalled();
});
