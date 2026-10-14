import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { chromeBridge, type ChromeConnection } from './chromeBridge';
const target = { profile: 'Profile 1', extension_id: 'a'.repeat(32) };
const connected: ChromeConnection = {
  targets: [{ profile: 'Default', extension_id: target.extension_id }, target],
  selected: { target, route_id: 'b'.repeat(64), instance_id: null }, error: null, host_error: null, last_received_at: null,
};
describe('Chrome routing', () => {
  beforeEach(() => vi.resetAllMocks());
  it('reports host registration failures before launching Chrome', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...connected, host_error: '无法注册本机组件' });
    await expect(chromeBridge.openWorkspace('workspace-1')).rejects.toThrow('无法注册本机组件');
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
  it('revalidates discovery instead of trusting an old cached extension', async () => {
    mocks.invoke.mockResolvedValueOnce(connected).mockResolvedValueOnce(undefined);
    await chromeBridge.openWorkspace('workspace-1');
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'discover_chrome_targets');
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'open_chrome_page', {
      extensionId: target.extension_id, profile: 'Profile 1', page: 'launcher', workspaceId: 'workspace-1',
    });
  });
  it('does not launch a profile when discovery is ambiguous, even with a cached ID', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...connected, selected: null, error: '请选择 Chrome Profile' });
    await expect(chromeBridge.openWorkspace('workspace-1')).rejects.toThrow('请选择');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it('rechecks the target on each launch after a profile changes', async () => {
    mocks.invoke.mockResolvedValueOnce(connected).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...connected, selected: null, error: 'Profile 已不可用' });
    await chromeBridge.openManager();
    await expect(chromeBridge.openManager()).rejects.toThrow('不可用');
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });
  it('does not fall back to stale configuration after an extension is removed', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...connected, targets: [], selected: null, error: 'Profile 已不可用' });
    await expect(chromeBridge.openManager()).rejects.toThrow('不可用');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it('persists an explicit target through the native command', async () => {
    mocks.invoke.mockResolvedValueOnce(connected);
    expect(await chromeBridge.select(target)).toEqual(connected);
    expect(mocks.invoke).toHaveBeenCalledWith('select_chrome_target', { profile: 'Profile 1', extensionId: target.extension_id });
  });
});
