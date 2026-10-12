import { browser } from 'wxt/browser';
import { hex, NATIVE_HOST } from './protocol';

const INSTANCE_KEY = 'windowstash-companion:instance:v1';
let pendingIdentity: Promise<string> | null = null;
function randomId() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export function instanceId(): Promise<string> {
  // Share concurrent requests; this is a routing label, never a credential.
  pendingIdentity ??= (async () => {
    const stored = (await browser.storage.local.get(INSTANCE_KEY))[INSTANCE_KEY];
    if (typeof stored === 'string' && /^[a-f0-9]{64}$/.test(stored)) return stored;
    const id = randomId();
    await browser.storage.local.set({ [INSTANCE_KEY]: id });
    return id;
  })().catch((error: unknown) => { pendingIdentity = null; throw error; });
  return pendingIdentity;
}

export interface ComponentStatus { companionRunning: boolean; sharedAuth: false; instanceId: string }
export async function checkCompanion(routeId: string | null = null): Promise<ComponentStatus> {
  const id = await instanceId();
  const requestId = randomId();
  if (routeId != null && !/^[a-f0-9]{64}$/.test(routeId)) throw new Error('无效的 Profile 关联请求');
  const port = browser.runtime.connectNative(NATIVE_HOST);
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: ComponentStatus) => {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      if (error) reject(error); else resolve(result!);
    };
    const onMessage = (raw: unknown) => {
      const value = raw as Record<string, unknown> | null;
      if (!value || value.version !== 1 || value.type !== 'status' || value.instance_id !== id
        || value.request_id !== requestId || value.shared_auth !== false || typeof value.companion_running !== 'boolean') {
        finish(new Error('本机组件返回了无效响应，未共享账号信息'));
      } else finish(undefined, { companionRunning: value.companion_running, sharedAuth: false, instanceId: id });
    };
    const onDisconnect = () => {
      const message = browser.runtime.lastError?.message ?? '';
      finish(new Error(/not found/i.test(message) ? '未找到本机组件，请打开 Companion 后重试'
        : /forbidden|permission/i.test(message) ? 'Chrome 未获准连接本机组件，请打开 Companion 更新注册后重试'
        : /exited|failed to start/i.test(message) ? '本机组件未能运行，请重新打开 Companion 后重试'
        : '与本机组件的连接已中断，请重试'));
    };
    const timer = setTimeout(() => finish(new Error('本机组件连接超时，请重试')), 5000);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try { port.postMessage({ version: 1, type: 'status', instance_id: id, request_id: requestId, route_id: routeId }); }
    catch { finish(new Error('无法发送本机组件检测请求，请重试')); }
  });
}
