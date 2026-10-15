// Dedicated test project only. No .env, application storage, or persisted sessions.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { subscribeWorkspaceChanges } from '../shared/workspaceRealtime.ts';

const TEST_REF = 'vavfmwqxqcixbtyulhux';
const TEST_URL = `https://${TEST_REF}.supabase.co`;
const TIMEOUT = 25_000;

export function validateTarget(url, key) {
  if (url !== TEST_URL || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('Only the dedicated test project and a publishable key are allowed');
  }
}

function client(key) {
  validateTarget(TEST_URL, key);
  return createClient(TEST_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => globalThis.fetch(input, {
        ...init,
        signal: globalThis.AbortSignal.any([
          globalThis.AbortSignal.timeout(TIMEOUT), ...(init?.signal ? [init.signal] : []),
        ]),
      }),
    },
  });
}

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name} failed (${error.code ?? 'network_error'})`);
  return data;
}

async function subscribe(db, uid) {
  const events = [];
  let readyCount = 0;
  let timer, close;
  try {
    await new Promise((resolve, reject) => {
      timer = globalThis.setTimeout(() => reject(new Error('Database-ready subscription timeout')), TIMEOUT);
      // Exercise the exact production subscription, rather than a copied configuration.
      close = subscribeWorkspaceChanges(db, uid, payload => {
        events.push({ table: payload.table, event: payload.eventType, row: payload.new });
      }, () => { readyCount++; resolve(); });
    });
  } catch (error) { await close?.(); throw error; }
  finally { globalThis.clearTimeout(timer); }
  return {
    events,
    close,
    get readyCount() { return readyCount; },
    async expect(table, event, id, mutation) {
      const start = events.length;
      await mutation();
      const deadline = Date.now() + TIMEOUT;
      while (!events.slice(start).some(item => item.table === table && item.event === event
        && (item.row.id ?? item.row.workspace_id) === id)) {
        if (Date.now() >= deadline) throw new Error(`Realtime ${table}/${event} timeout`);
        await new Promise(resolve => globalThis.setTimeout(resolve, 100));
      }
      this.checkIsolation();
    },
    checkIsolation() {
      assert(events.every(item => item.row.user_id === uid), 'Realtime exposed another account');
    },
  };
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('Run interactively in a local terminal');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  async function secret(label) {
    process.stdout.write(label);
    muted = true;
    try { return await prompt.question(''); }
    finally { muted = false; process.stdout.write('\n'); }
  }
  let key, emailA, emailB, passwordA, passwordB;
  try {
    console.log(`TEST PROJECT ONLY: ${TEST_REF}`);
    console.log('Creates fake workspaces; cleanup leaves test tombstones. No Windows network changes.');
    key = (await secret('Test publishable key (hidden): ')).trim();
    validateTarget(TEST_URL, key);
    emailA = (await prompt.question('Test account A email: ')).trim();
    passwordA = await secret('Test account A password (hidden): ');
    emailB = (await prompt.question('Test account B email: ')).trim();
    passwordB = await secret('Test account B password (hidden): ');
    if (emailA === emailB) throw new Error('Two different test accounts are required');
    const confirmation = await prompt.question('Type TEST to create fake test records: ');
    if (confirmation !== 'TEST') throw new Error('Cancelled; no network requests made');
  } finally { prompt.close(); }

  const a = client(key), b = client(key), observer = client(key);
  const owned = new Map();
  const subscriptions = [];
  let cleanupFailed = false;
  async function put(db, id, name, previous = null) {
    owned.set(id, db);
    return rpc(db, 'windowstash_put_v1', {
      workspace: { id, name, status: 'active',
        tabs: [{ url: 'https://example.com/', title: 'Isolated sync test', pinned: false }],
        active_tab_index: 0, content_hash: `isolated-${name}`, created_at: new Date().toISOString() },
      expected_updated_at: previous?.updated_at ?? null,
    });
  }
  const remove = (db, id) => rpc(db, 'windowstash_delete_v1', { workspace_id: id });
  try {
    const loginA = await a.auth.signInWithPassword({ email: emailA, password: passwordA });
    passwordA = undefined;
    if (loginA.error) throw new Error('Account A login failed; check password and email confirmation');
    const loginB = await b.auth.signInWithPassword({ email: emailB, password: passwordB });
    passwordB = undefined;
    if (loginB.error) throw new Error('Account B login failed; check password and email confirmation');
    assert.notEqual(loginA.data.user.id, loginB.data.user.id);
    // Observer represents a second device using account A, separate from the writer.
    const observed = await observer.auth.setSession({
      access_token: loginA.data.session.access_token,
      refresh_token: loginA.data.session.refresh_token,
    });
    if (observed.error) throw new Error('Second-device session setup failed');
    console.log('PASS: real authentication for two distinct test accounts');

    // Read once before subscribing, then mutate while the real subscription joins.
    // The post-readiness snapshot must close that gap, even without a row hint.
    const joiningId = randomUUID();
    const beforeJoin = await rpc(observer, 'windowstash_snapshot_v1');
    assert(!beforeJoin.records.some(item => item.id === joiningId));
    const joining = subscribe(observer, loginA.data.user.id);
    // Attach a handler immediately in case the concurrent write fails first.
    void joining.catch(() => {});
    await put(a, joiningId, 'WS-DURING-SUBSCRIPTION');
    let streamA = await joining;
    subscriptions.push(streamA);
    const afterJoin = await rpc(observer, 'windowstash_snapshot_v1');
    assert.equal(afterJoin.records.find(item => item.id === joiningId)?.name, 'WS-DURING-SUBSCRIPTION');
    console.log('PASS: production database-ready subscription and post-join gap calibration');
    const streamB = await subscribe(b, loginB.data.user.id);
    subscriptions.push(streamB);
    const id = randomUUID();
    let row;
    await streamA.expect('workspaces', 'INSERT', id, async () => {
      row = await put(a, id, 'WS-LIVE-CREATE');
    });
    await streamA.expect('workspaces', 'UPDATE', id, async () => {
      row = await put(a, id, 'WS-LIVE-UPDATE', row);
    });
    let snapshot = await rpc(observer, 'windowstash_snapshot_v1');
    const downloaded = snapshot.records.find(item => item.id === id);
    assert.equal(downloaded?.name, 'WS-LIVE-UPDATE');
    assert.deepEqual(downloaded.tabs, row.tabs);
    const foreign = await b.from('workspaces').select('id').eq('id', id);
    assert.equal(foreign.error, null);
    assert.deepEqual(foreign.data, []);
    await streamA.expect('workspace_tombstones', 'INSERT', id, () => remove(a, id));
    console.log('PASS: Realtime create/update/delete hints and full snapshot download');

    const resurrection = await a.rpc('windowstash_put_v1', {
      workspace: row, expected_updated_at: null,
    });
    assert.equal(resurrection.error?.message, 'workspace_deleted');
    const foreignMarker = await b.from('workspace_tombstones').select('workspace_id').eq('workspace_id', id);
    assert.equal(foreignMarker.error, null);
    assert.deepEqual(foreignMarker.data, []);
    const bId = randomUUID();
    await streamB.expect('workspaces', 'INSERT', bId, () => put(b, bId, 'WS-LIVE-B'));
    streamA.checkIsolation(); streamB.checkIsolation();
    console.log('PASS: REST resurrection rejection and observed Realtime account isolation');

    // Disconnect only the simulated second device, never the Windows network.
    await streamA.close();
    const changedId = randomUUID(), removedId = randomUUID(), addedId = randomUUID();
    let changed = await put(a, changedId, 'WS-BEFORE-DISCONNECT');
    await put(a, removedId, 'WS-REMOVED-WHILE-DISCONNECTED');
    changed = await put(a, changedId, 'WS-UPDATED-WHILE-DISCONNECTED', changed);
    await remove(a, removedId);
    await put(a, addedId, 'WS-ADDED-WHILE-DISCONNECTED');
    const reconnecting = subscribe(observer, loginA.data.user.id);
    void reconnecting.catch(() => {});
    const duringReconnectId = randomUUID();
    await put(a, duringReconnectId, 'WS-DURING-RECONNECT');
    streamA = await reconnecting;
    subscriptions.push(streamA);
    snapshot = await rpc(observer, 'windowstash_snapshot_v1');
    assert.equal(snapshot.records.find(item => item.id === changedId)?.name, changed.name);
    assert(snapshot.records.some(item => item.id === addedId));
    assert(!snapshot.records.some(item => item.id === removedId));
    assert(snapshot.deleted.some(item => item.workspace_id === removedId));
    assert(snapshot.records.some(item => item.id === duringReconnectId));
    await streamA.expect('workspaces', 'UPDATE', addedId, async () => {
      const current = snapshot.records.find(item => item.id === addedId);
      await put(a, addedId, 'WS-AFTER-RECONNECT', current);
    });
    streamA.checkIsolation(); streamB.checkIsolation();
    console.log('PASS: resubscribe, missed create/update/delete calibration, resumed live events');

    // Keep the same subscription; exercise the SDK's WebSocket recovery path too.
    observer.realtime.disconnect();
    const socketGapId = randomUUID();
    await put(a, socketGapId, 'WS-DURING-SOCKET-DISCONNECT');
    const readyBeforeReconnect = streamA.readyCount;
    observer.realtime.connect();
    const readyDeadline = Date.now() + TIMEOUT;
    while (streamA.readyCount === readyBeforeReconnect) {
      if (Date.now() >= readyDeadline) throw new Error('Existing subscription did not recover');
      await new Promise(resolve => globalThis.setTimeout(resolve, 100));
    }
    snapshot = await rpc(observer, 'windowstash_snapshot_v1');
    const missed = snapshot.records.find(item => item.id === socketGapId);
    assert.equal(missed?.name, 'WS-DURING-SOCKET-DISCONNECT');
    await streamA.expect('workspaces', 'UPDATE', socketGapId,
      () => put(a, socketGapId, 'WS-SOCKET-RECOVERED', missed));
    streamA.checkIsolation(); streamB.checkIsolation();
    console.log('PASS: existing subscription WebSocket reconnect, ready recalibration, subsequent events');
  } finally {
    for (const stream of subscriptions) await stream.close().catch(() => {});
    for (const [id, db] of owned) {
      try { await remove(db, id); }
      catch { cleanupFailed = true; console.error(`CLEANUP PENDING: fake workspace ${id}`); }
    }
    for (const db of [a, b, observer]) {
      await db.removeAllChannels().catch(() => {});
      await db.auth.signOut({ scope: 'local' }).catch(() => {});
    }
    if (owned.size && !cleanupFailed) console.log('Cleanup: only this run\'s fake workspace IDs deleted; test tombstones retained.');
  }
  if (cleanupFailed) throw new Error('Fake-workspace cleanup incomplete; keep the printed IDs');
  console.log('DONE: database/API harness passed. Installed apps and physical offline tests remain unverified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
}
