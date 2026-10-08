import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = vi.hoisted(() => ({ onMessage: undefined as ((message: unknown, sender: unknown) => unknown) | undefined }));
const reopenMock = vi.hoisted(() => vi.fn());

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
    tabs: { onActivated: event(), onCreated: event(), onUpdated: event(), onRemoved: event() },
  };
});

vi.mock('wxt/browser', () => ({ browser: browserMock }));
vi.mock('@/features/workspaces/workspaceService', () => ({
  openOrFocusWorkspace: vi.fn(),
  reopenWorkspace: reopenMock,
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
  hydrateStartupLazyTab: vi.fn(),
  hydrateStartupLazyTabs: vi.fn(),
  isStartupLazyReconciliationActive: vi.fn(),
  noteStartupLazyActivity: vi.fn(),
  removeLazyTab: vi.fn(),
  resolveLazyTab: vi.fn(),
}));

beforeAll(async () => {
  vi.stubGlobal('defineBackground', (setup: () => void) => setup());
  await import('@/entrypoints/background');
});

describe('background messages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the complete reopen flow in background', async () => {
    reopenMock.mockResolvedValue(99);

    await expect(listeners.onMessage?.({
      type: 'REOPEN_WORKSPACE',
      workspaceId: 'workspace-1',
      sourceWindowId: 22,
    }, {})).resolves.toBe(99);

    expect(reopenMock).toHaveBeenCalledWith('workspace-1', 22);
  });
});
