import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickSaveMessage, QuickSaveReply } from '../quickSaveProtocol';

type Listener = (message: unknown, sender: { id?: string }, reply: (message: unknown) => void) => unknown;
const mocks = vi.hoisted(() => ({ current: vi.fn(), send: vi.fn(), show: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { tabs: { getCurrent: mocks.current }, runtime: { id: 'test', sendMessage: mocks.send, onMessage: { addListener: mocks.add, removeListener: mocks.remove } } } }));
vi.mock('../quickSaveDialog', () => ({ showQuickSaveDialog: mocks.show }));
import { registerQuickSavePage } from '../quickSavePage';
const command = { type: 'QUICK_SAVE_SHOW', tabId: 3, windowId: 22, token: 'grant' };

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('window', new EventTarget());
  mocks.current.mockResolvedValue({ id: 3, windowId: 22 }); mocks.show.mockReturnValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describe('management page quick-save bridge', () => {
  it('renders the existing dialog and attaches the exact command context to its requests', async () => {
    await registerQuickSavePage(); const listener = mocks.add.mock.calls[0]![0] as Listener, reply = vi.fn();
    expect(listener(command, { id: 'test' }, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ shown: true }));
    const send = mocks.show.mock.calls[0]![0] as (message: QuickSaveMessage) => Promise<QuickSaveReply>;
    await send({ type: 'QUICK_SAVE_PREVIEW' });
    expect(mocks.send).toHaveBeenCalledWith({ type: 'QUICK_SAVE_PREVIEW', pageContext: { tabId: 3, windowId: 22, token: 'grant' } });
    window.dispatchEvent(new Event('pagehide'));
    expect(mocks.remove).toHaveBeenCalledWith(listener);
  });
  it('does not claim broadcast messages intended for another tab or another sender', async () => {
    await registerQuickSavePage(); const listener = mocks.add.mock.calls[0]![0] as Listener, reply = vi.fn();
    expect(listener({ ...command, tabId: 9 }, { id: 'test' }, reply)).toBeUndefined();
    expect(listener(command, { id: 'other' }, reply)).toBeUndefined();
    expect(listener({ type: 'QUICK_SAVE_PREVIEW' }, { id: 'test' }, reply)).toBeUndefined();
    expect(mocks.show).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled();
  });
  it('rejects a management tab moved to another window', async () => {
    await registerQuickSavePage(); mocks.current.mockResolvedValue({ id: 3, windowId: 42 });
    const reply = vi.fn(); (mocks.add.mock.calls[0]![0] as Listener)(command, { id: 'test' }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ error: '管理页已移动，请重新按快捷键', kind: 'unavailable' }));
    expect(mocks.show).not.toHaveBeenCalled();
  });
  it('reports actual dialog execution errors rather than acknowledging a missing dialog', async () => {
    await registerQuickSavePage(); mocks.show.mockImplementation(() => { throw new Error('showModal failed'); });
    const reply = vi.fn(); (mocks.add.mock.calls[0]![0] as Listener)(command, { id: 'test' }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ error: 'showModal failed', kind: 'execution' }));
  });
  it('does not register a receiver in a view without a Chrome tab', async () => {
    mocks.current.mockResolvedValue(undefined); await registerQuickSavePage(); expect(mocks.add).not.toHaveBeenCalled();
  });
});
