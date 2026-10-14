import { authLink, nativeAuth } from '@/lib/companion/auth';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/lib/constants';
import { persistLibraryChange } from '@/lib/companion/workspaces';
const OWNER = 'windowstash-data-owner:v1';
const REVISION = 'windowstash-data-revision:v1';
const MIGRATED = 'windowstash-data-migrated:v1';
const RECOVERED = 'windowstash-unowned-recovered:v1';
export const accountOwner = (url: string, userId: string) => JSON.stringify([new URL(url).href.replace(/\/+$/, ''), userId]);
export async function legacyDataSummary() {
  const keys = [STORAGE_KEYS.workspaces, STORAGE_KEYS.tombstones];
  const state = await browser.storage.local.get([MIGRATED, RECOVERED, ...keys, ...keys.map((key) => `${key}:signed-out`)]);
  const count = (key: string) => Object.keys({ ...(!state[MIGRATED] ? state[key] as object : {}), ...(!state[RECOVERED] ? state[`${key}:signed-out`] as object : {}) }).length;
  return { workspaces: count(STORAGE_KEYS.workspaces), tombstones: count(STORAGE_KEYS.tombstones) };
}

export const dataAccountHidden = async () => (await browser.storage.local.get(OWNER))[OWNER] === 'signed-out';
export function dataAccountLock<T>(task: () => Promise<T>): Promise<T> {
  return globalThis.navigator?.locks ? navigator.locks.request('windowstash-data-owner', task).then((result) => result) : task();
}
export async function hideDataAccount() {
  await dataAccountLock(() => browser.storage.local.set({ [OWNER]: 'signed-out', [REVISION]: crypto.randomUUID() }));
}
export async function requireDataAccount(expectedKey?: string) {
  const state = await browser.storage.local.get([OWNER, REVISION, STORAGE_KEYS.supabaseConfig]);
  const config = state[STORAGE_KEYS.supabaseConfig] as { url?: string } | undefined;
  const owner = state[OWNER];
  if (!config?.url || typeof owner !== 'string' || owner === 'signed-out' || await currentOwner(config.url) !== owner) throw new Error('请先登录 WindowStash');
  const latest = await browser.storage.local.get([OWNER, REVISION]);
  if (latest[OWNER] !== owner || latest[REVISION] !== state[REVISION]) throw new Error('账号已变化，请重新操作');
  const storageKey = `${STORAGE_KEYS.workspaces}:${owner}`;
  if (expectedKey && expectedKey !== storageKey) throw new Error('账号已变化，请重新操作');
  return { storageKey, revision: state[REVISION] };
}
export async function withDataAccount<T>(account: Awaited<ReturnType<typeof requireDataAccount>>, task: () => Promise<T>) {
  return dataAccountLock(async () => {
    const current = await requireDataAccount();
    if (account.storageKey !== current.storageKey || account.revision !== current.revision) throw new Error('账号已变化，请重新操作');
    return task();
  });
}
async function currentOwner(url: string): Promise<string | null> {
  let userId: string | undefined;
  if (await authLink()) {
    const reply = await nativeAuth('read');
    if (reply.config?.url.replace(/\/+$/, '') === url.replace(/\/+$/, '')) userId = reply.session?.user.id;
  } else {
    const key = `windowstash-auth:sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
    const raw = (await browser.storage.local.get(key))[key];
    try { userId = typeof raw === 'string' ? JSON.parse(raw).user?.id : undefined; } catch { /* Hide unreadable sessions. */ }
  }
  return userId ? accountOwner(url, userId) : null;
}
export async function accountStorageKey(key: string): Promise<string> {
  const state = await browser.storage.local.get([OWNER, STORAGE_KEYS.supabaseConfig]);
  const config = state[STORAGE_KEYS.supabaseConfig] as { url?: string } | undefined;
  const owner = state[OWNER];
  if (!config?.url && owner) return `${key}:signed-out`;
  if (config?.url) {
    const current = await currentOwner(config.url);
    if (!current || owner === 'signed-out') return `${key}:signed-out`;
    if (owner !== current) {
      if (owner) return `${key}:signed-out`;
      await initializeDataAccount(config.url, (JSON.parse(current) as [string, string])[1]);
      return `${key}:${current}`;
    }
  }
  return typeof owner === 'string' ? `${key}:${owner}` : key;
}
/** Preserve the legacy copy and every previous account. Never clear pending records. */
async function select(url: string, userId: string, migrate = false, recoverUnowned = false) {
  const owner = accountOwner(url, userId);
  const state = await browser.storage.local.get([OWNER, MIGRATED]);

  const keys = [STORAGE_KEYS.workspaces, STORAGE_KEYS.tombstones, STORAGE_KEYS.syncLogs];
  if ((!state[MIGRATED] && migrate) || state[MIGRATED] === owner) {
    const data = await browser.storage.local.get([...keys, ...keys.map((key) => `${key}:${owner}`)]);
    const preserved: Record<string, unknown> = {};
    for (const key of keys) {
      const target = `${key}:${owner}`;
      const legacy = data[key];
      const existing = data[target];
      if (legacy === undefined || (state[MIGRATED] && existing !== undefined)) continue;
      // Current records win collisions; retain the untouched legacy backup as well.
      preserved[target] = key === STORAGE_KEYS.syncLogs
        ? [...(existing as unknown[] | undefined ?? []), ...(legacy as unknown[])]
        : { ...(legacy as object), ...(existing as object | undefined) };
    }
    if (Object.keys(preserved).length || !state[MIGRATED] || state[OWNER] !== owner) {
      await persistLibraryChange(`${STORAGE_KEYS.workspaces}:${owner}`, { ...preserved, [MIGRATED]: owner, [OWNER]: owner, ...(state[OWNER] !== owner ? { [REVISION]: crypto.randomUUID() } : {}) });
    }
  } else if (state[OWNER] !== owner) await browser.storage.local.set({ [OWNER]: owner, [REVISION]: crypto.randomUUID() });
  if (recoverUnowned) {
    const data = await browser.storage.local.get([RECOVERED, ...keys.map((key) => `${key}:signed-out`), ...keys.map((key) => `${key}:${owner}`)]);
    if (!data[RECOVERED]) {
      const copies: Record<string, unknown> = {};
      for (const key of keys) {
        const source = data[`${key}:signed-out`];
        if (source === undefined) continue;
        const existing = data[`${key}:${owner}`];
        copies[`${key}:${owner}`] = key === STORAGE_KEYS.syncLogs
          ? [...(existing as unknown[] ?? []), ...(source as unknown[])]
          : { ...(source as object), ...(existing as object ?? {}) };
      }
      if (Object.keys(copies).length) await persistLibraryChange(`${STORAGE_KEYS.workspaces}:${owner}`, { ...copies, [RECOVERED]: owner });
    }
  }
  const legacyOwner = state[MIGRATED] ?? (migrate ? owner : null);
  const upgrade = 'windowstash-account-metadata:v2';
  if (legacyOwner === owner && !(await browser.storage.local.get(upgrade))[upgrade]) {
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key === STORAGE_KEYS.lazyRestoreEntries || (key.startsWith(STORAGE_KEYS.windowAssociationPrefix) && !key.includes('[')));
    const destination = (key: string) => key.startsWith(STORAGE_KEYS.windowAssociationPrefix) ? `${STORAGE_KEYS.windowAssociationPrefix}:${owner}:${key.slice(STORAGE_KEYS.windowAssociationPrefix.length)}` : `${key}:${owner}`;
    const copies = Object.fromEntries(keys.filter((key) => all[destination(key)] === undefined).map((key) => [destination(key), all[key]]));
    await browser.storage.local.set({ ...copies, [upgrade]: owner });
    if (browser.storage.session) {
      const session = await browser.storage.session.get(null);
      const bindings = Object.fromEntries(Object.entries(session).filter(([key]) => /^(windowBinding|windowBindingSuppressed):\d+$/.test(key)).map(([key, value]) => [`${key}:${owner}`, value]));
      if (Object.keys(bindings).length) await browser.storage.session.set(bindings);
    }
  }
}

export async function selectDataAccount(url: string, userId: string, migrate = false) {
  const task = async () => {
    const config = (await browser.storage.local.get(STORAGE_KEYS.supabaseConfig))[STORAGE_KEYS.supabaseConfig] as { url?: string } | undefined;
    if (config?.url && (accountOwner(config.url, userId) !== accountOwner(url, userId) || await currentOwner(url) !== accountOwner(url, userId))) throw new Error('账号已变化，请重新加载后再同步');
    await select(url, userId, migrate, migrate);
  };
  if (globalThis.navigator?.locks) await navigator.locks.request('windowstash-data-owner', task);
  else await task();
}
export async function initializeDataAccount(url: string, userId: string) {
  const task = async () => {
    const state = await browser.storage.local.get([OWNER, STORAGE_KEYS.supabaseConfig]);
    const config = state[STORAGE_KEYS.supabaseConfig] as { url?: string } | undefined;
    const owner = accountOwner(url, userId);
    if (state[OWNER] === 'signed-out') return;
    if (config?.url && (accountOwner(config.url, userId) !== owner || await currentOwner(url) !== owner)) {
      throw new Error('账号已变化，请重新加载后再同步');
    }
    await select(url, userId, !state[OWNER]);
  };
  if (globalThis.navigator?.locks) await navigator.locks.request('windowstash-data-owner', task);
  else await task();
}
