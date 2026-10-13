import { browser } from 'wxt/browser';
import type { Session } from '@supabase/supabase-js';
import { instanceId } from './connection';
import { NATIVE_HOST } from './protocol';
import { measurePopupStage } from '@/lib/popupPerformance';

export const LINK_KEY = 'windowstash-companion:auth-link:v1';
interface Link { capability: string }
interface Reply { completed?: boolean; failure?: string; session: Session | null; config: { url: string; publishable_key: string }; capability: string }
const reads = new Map<string, Promise<Reply>>();
export class NativeAuthError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
let authRevision = 0;
export async function authLink(): Promise<Link | null> {
  return (await browser.storage.local.get(LINK_KEY))[LINK_KEY] as Link | undefined ?? null;
}
export async function nativeAuth(action: string, extra: Record<string, unknown> = {}): Promise<Reply> {
  return measurePopupStage('native-auth', () => performNativeAuth(action, extra));
}
async function performNativeAuth(action: string, extra: Record<string, unknown>): Promise<Reply> {
  // Share only concurrent reads. Never reuse a completed identity verification.
  if (action !== 'read') { authRevision++; reads.clear(); }
  const revision = authRevision;
  const [state, instance] = await Promise.all([
    measurePopupStage('native-storage', () => browser.storage.local.get(action === 'read'
      ? [LINK_KEY, 'supabaseConfig', 'windowstash-data-owner:v1', 'windowstash-data-revision:v1', 'windowstash-companion:auth-revision']
      : LINK_KEY)),
    instanceId(),
  ]);
  const link = state[LINK_KEY] as Link | undefined ?? null;
  if (action === 'read') {
    const key = JSON.stringify([revision, instance, link, state, extra]);
    const existing = reads.get(key);
    if (existing) return existing;
    const task = sendAuth(action, extra, link, instance);
    reads.set(key, task);
    try { return await task; }
    finally { if (reads.get(key) === task) reads.delete(key); }
  }
  return sendAuth(action, extra, link, instance);
}
async function sendAuth(action: string, extra: Record<string, unknown>, link: Link | null, instance: string): Promise<Reply> {
  const response = await measurePopupStage('native-message', () => browser.runtime.sendNativeMessage(NATIVE_HOST, {
    version: 1, type: 'auth', action, instance_id: instance, capability: link?.capability ?? null,
    login_request: null, route_id: null, config: null, session: null, ...extra,
  })) as Reply & { status?: string; code?: string };
  if (response?.status === 'error') {
    const code = response.code ?? 'unknown';
    const messages: Record<string, string> = {
      not_linked: '桌面授权关联已失效，请重新登录并授权',
      login_request_missing: '登录请求已失效，请返回 Companion 重新开始',
      login_request_expired: '登录请求已过期，请返回 Companion 重新开始',
      unauthorized_instance: '浏览器与桌面端的关联已失效，请返回 Companion 重新开始',
      invalid_session: '当前浏览器登录已失效，请重新登录后再确认',
      invalid_project_config: '数据存储配置无法用于授权，请检查浏览器中的 Supabase 配置',
      network_unavailable: '暂时无法连接云端，请检查网络后重试',
      invalid_server_response: '云端返回了异常响应，请检查网络后重试',
      session_refresh_failed: '登录已失效，请在浏览器中重新登录',
      auth_store_unavailable: '无法保存登录状态，请重新打开 Companion 后重试',
      auth_store_corrupt: '无法读取已保存的登录状态，请重新打开 Companion',
      invalid_auth_request: '应用版本不匹配，请更新扩展和 Companion 后重试',
    };
    console.warn('WindowStash authorization failed:', code); // Fixed code only, never credentials.
    const message = messages[code] ?? '授权未完成，请重新打开 Companion 后重试';
    throw new NativeAuthError(code, message);
  }
  if (!response || !/^[a-f0-9]{64}$/.test(response.capability) || !('session' in response)) throw new Error('本机授权响应无效，请重试');
  if (action === 'clear' || action === 'replace') {
    await browser.storage.local.set({ 'windowstash-companion:auth-revision': crypto.randomUUID() });
  }
  return response;
}
/** All extension contexts serialize refresh and transfer under the same Web Lock. */
export function authLock<T>(task: () => Promise<T>): Promise<T> {
  return navigator.locks.request('windowstash-auth-owner', task).then((result) => result);
}

export function transferSession(session: Session, stored: unknown): Session {
  try {
    const next = typeof stored === 'string' ? JSON.parse(stored) as Session : null;
    return next?.user?.id === session.user.id && next.refresh_token && (next.expires_at ?? 0) > (session.expires_at ?? 0) ? next : session;
  } catch { return session; }
}

export async function authorizeCompanion(config: { url: string; publishableKey: string }, session: Session, request: string, route: string) {
  await authLock(async () => {
    // A refresh may have completed between the UI reading Session and acquiring the lock.
    // Use the SDK-validated session, never override it with a raw (possibly stale) storage snapshot.
    const storageKey = `windowstash-auth:sb-${new URL(config.url).hostname.split('.')[0]}-auth-token`;
    const stored = (await browser.storage.local.get(storageKey))[storageKey];
    const latest = await authLink() ? (await nativeAuth('read')).session ?? session : transferSession(session, stored);
    const reply = await nativeAuth('bootstrap', {
      login_request: request, route_id: route,
      config: { url: config.url, publishable_key: config.publishableKey }, session: latest,
    });
    if (!reply.session) throw new Error('浏览器账号已退出，请重新登录');
    await browser.storage.local.set({ [LINK_KEY]: { capability: reply.capability } });
  });
}
