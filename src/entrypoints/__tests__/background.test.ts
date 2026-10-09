import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = vi.hoisted(() => ({
  onMessage: undefined as ((message: unknown, sender: unknown) => unknown) | undefined,
  onCreated: undefined as ((tab: { windowId: number }) => void) | undefined,
  onRemoved: undefined as ((tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void) | undefined,
  onMoved: undefined as ((tabId: number, info: { windowId: number }) => void) | undefined,
}));
const reopenMock = vi.hoisted(() => vi.fn());
const recoverMock = vi.hoisted(() => vi.fn());
const restoreSavedMock = vi.hoisted(() => vi.fn());
const refreshAssociationMock = vi.hoisted(() => vi.fn());

const browserMock = vi.hoisted(() => {
  const event = () => ({ addListener: vi.fn() });
  return {
    alarms: { create: vi.fn(), onAlarm: event() },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: { addListener: vi.fn((listener) => { listeners.onMessage = listener; }) },
    },
    windows: { onRemoved: event() },
    tabs: {
      onActivated: event(),
      onCreated: { addListener: vi.fn((listener) => { listeners.onCreated = listener; }) },
      onUpdated: event(),
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
  beginStartupLazyReconciliation: vi.fn(),
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
  beforeEach(() => {
    vi.clearAllMocks();
    refreshAssociationMock.mockResolvedValue(true);
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
