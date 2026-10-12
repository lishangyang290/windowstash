import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), connect: vi.fn(), runtimeError: { message: '' } }));
vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: mocks.get, set: mocks.set } }, runtime: { connectNative: mocks.connect, lastError: mocks.runtimeError } } }));
describe('non-credential Companion connection', () => {
  beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); mocks.runtimeError.message = ''; mocks.get.mockResolvedValue({}); mocks.set.mockResolvedValue(undefined); });
  it('persists one instance label for concurrent checks without generating credential keys', async () => {
    const { instanceId } = await import('../connection');
    const [a, b] = await Promise.all([instanceId(), instanceId()]);
    expect(a).toBe(b); expect(a).toMatch(/^[a-f0-9]{64}$/); expect(mocks.set).toHaveBeenCalledTimes(1);
  });
  for (const invalid of [false, true]) it(`checks echoed request and rejects credential capability: ${invalid}`, async () => {
    let callback: (value: unknown) => void = () => {};
    const port = { onMessage: { addListener: vi.fn((fn) => { callback = fn; }), removeListener: vi.fn() }, onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() }, disconnect: vi.fn(), postMessage: vi.fn((request) => {
      expect(Object.keys(request).sort()).toEqual(['instance_id', 'request_id', 'route_id', 'type', 'version']);
      callback({ ...request, shared_auth: invalid, companion_running: true });
    }) };
    mocks.connect.mockReturnValue(port);
    const { checkCompanion } = await import('../connection');
    if (invalid) await expect(checkCompanion()).rejects.toThrow('无效响应');
    else expect(await checkCompanion()).toMatchObject({ companionRunning: true, sharedAuth: false });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['Specified native messaging host not found.', '未找到本机组件'],
    ['Access to the specified native messaging host is forbidden.', 'Chrome 未获准连接'],
    ['Native host has exited.', '本机组件未能运行'],
    ['Error when communicating with the native messaging host.', '连接已中断'],
  ])('reports the actual Chrome disconnect category: %s', async (message, expected) => {
    let disconnect = () => {};
    mocks.connect.mockReturnValue({
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn((fn) => { disconnect = fn; }), removeListener: vi.fn() },
      disconnect: vi.fn(), postMessage: vi.fn(() => { mocks.runtimeError.message = message; disconnect(); }),
    });
    const { checkCompanion } = await import('../connection');
    await expect(checkCompanion()).rejects.toThrow(expected);
  });

});
