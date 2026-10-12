// Stage 1 real stdio negative control. Requires explicit insecure-test-store.
// Never registers a Chrome Host. Does not validate production credential storage.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const binary = fileURLToPath(new URL('../companion/native-host/target/insecure-fixture/debug/windowstash-native-host', import.meta.url));
const directory = await mkdtemp(resolve(tmpdir(), 'windowstash-host-test-'));
const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const profile = {
  id: hex(webcrypto.getRandomValues(new Uint8Array(32))), origin,
  public_key: hex(await webcrypto.subtle.exportKey('raw', keys.publicKey)),
};

function launch() {
  const child = spawn(binary, [origin], { env: { ...process.env, WINDOWSTASH_AUTH_TEST_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = Buffer.alloc(0);
  const frames = [];
  const waiting = [];
  let failure;
  const timer = setTimeout(() => child.kill(), 5_000);
  const fail = (error) => {
    failure = error;
    waiting.splice(0).forEach(({ reject }) => reject(error));
  };
  const done = new Promise((fulfill, reject) => {
    child.on('error', (error) => { fail(error); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fail(new Error('Host disconnected'));
      fulfill({ code, signal });
    });
  });
  child.stdout.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4) {
      const length = bytes.readUInt32LE();
      assert(length > 0 && length <= 16 * 1024);
      if (bytes.length < length + 4) break;
      const frame = JSON.parse(bytes.subarray(4, length + 4).toString('utf8'));
      bytes = bytes.subarray(length + 4);
      const next = waiting.shift();
      if (next) next.fulfill(frame); else frames.push(frame);
    }
  });
  return {
    child, done,
    next() {
      if (frames.length) return Promise.resolve(frames.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((fulfill, reject) => waiting.push({ fulfill, reject }));
    },
    send(value) {
      const payload = Buffer.from(JSON.stringify(value), 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32LE(payload.length);
      child.stdin.end(Buffer.concat([length, payload]));
    },
  };
}

async function command(operation, signatureOverride, privateKey = keys.privateKey) {
  const host = launch();
  const hello = await host.next();
  const payload = JSON.stringify({
    version: 1, challenge: hello.challenge, profile_id: profile.id,
    generation: hello.generation, sequence: hello.last_sequence + 1,
    expected_revision: hello.revision, operation,
  });
  const signature = signatureOverride ?? hex(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(payload, 'utf8')));
  host.send({ type: 'command', signed: { payload, signature } });
  const reply = await host.next();
  await host.done;
  return reply;
}

try {
  const pairingHost = launch();
  assert.equal((await pairingHost.next()).version, 1);
  pairingHost.send({ type: 'pair', profile });
  const pending = await pairingHost.next();
  assert.equal(pending.status, 'awaiting_desktop_confirmation');
  await pairingHost.done;
  const path = resolve(directory, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(state.owner, null);
  // Trusted test fixture simulates desktop approval. The Rust approval API has
  // separate tests; no browser/UI approval or system registration is implied.
  Object.assign(state, { owner: profile, pairing: null, generation: hex(webcrypto.getRandomValues(new Uint8Array(32))), revision: 1 });
  await writeFile(path, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });

  assert.equal((await command({ type: 'snapshot' })).status, 'persisted');
  assert.equal((await command({ type: 'snapshot' }, '00'.repeat(64))).code, 'invalid_signature');
  const invalidated = await command({ type: 'invalidate', reason: 'logout' });
  assert.equal(invalidated.state.revision, 2);
  assert.equal(invalidated.state.invalidated, true);

  const interrupted = launch();
  await interrupted.next();
  interrupted.child.kill();
  await interrupted.done;
  const restored = await command({ type: 'snapshot' });
  assert.equal(restored.state.revision, 2);
  assert.equal(restored.state.invalidated, true);
  // Adversarial gate: a different same-user process can replace the trusted
  // public key in this prototype's unsigned ledger. Keep this failure visible.
  const attacker = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const altered = JSON.parse(await readFile(path, 'utf8'));
  altered.owner.public_key = hex(await webcrypto.subtle.exportKey('raw', attacker.publicKey));
  await writeFile(path, JSON.stringify(altered), { encoding: 'utf8', mode: 0o600 });
  const forged = await command({ type: 'snapshot' }, undefined, attacker.privateKey);
  const securityGateFailed = forged.status === 'persisted';
  assert.equal((await command({ type: 'unpair' }, undefined, attacker.privateKey)).state.owner, null);
  assert.equal((await command({ type: 'snapshot' })).code, 'not_paired');
  console.log('Native Host 进程验证通过：WebCrypto/Rust 签名互通、错误签名拒绝、失效记录持久化、进程中断恢复、解除配对。未注册 Host，未进行真实 Chrome 联动。');
  if (securityGateFailed) {
    console.error('阶段 1 安全门槛未通过：不安全测试后端仍可被同用户进程篡改公钥。该负面对照已隔离于显式 debug 测试构建；必须验证可靠的独立信任根与状态保护后才能接入账号流程。');
    process.exitCode = 1;
  }
} finally {
  // Remove only the dedicated temporary test directory created by this script.
  await rm(directory, { recursive: true, force: true });
}
