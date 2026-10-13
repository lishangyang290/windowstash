// Status remains non-credential; authorization uses a separate scoped request. No system registration.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const suffix = process.platform === 'win32' ? '.exe' : '';
const target = process.env.TAURI_ENV_TARGET_TRIPLE;
const binary = fileURLToPath(new URL(`../companion/native-host/target/${target ? `${target}/` : ''}release/windowstash-native-host${suffix}`, import.meta.url));
const directory = await mkdtemp(resolve(tmpdir(), 'windowstash-untrusted-host-'));
try {
  const ledger = resolve(directory, 'state.json');
  await writeFile(ledger, JSON.stringify({ owner: 'attacker', revision: 0 }), 'utf8');
  const result = spawnSync(binary, ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], {
    env: { ...process.env, WINDOWSTASH_AUTH_TEST_DIR: directory },
    input: Buffer.alloc(0), timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  const length = result.stdout.readUInt32LE();
  assert.equal(result.stdout.length, length + 4, 'must not send a challenge or state before identity validation');
  const response = JSON.parse(result.stdout.subarray(4).toString('utf8'));
  assert.equal(response.status, 'error');
  assert.equal(response.code, 'trusted_bootstrap_unavailable');
  const request = { version: 1, type: 'status', instance_id: 'a'.repeat(64), request_id: 'b'.repeat(64), route_id: null };
  function exchange(value) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
    const reply = spawnSync(binary, ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], {
      env: { ...process.env, WINDOWSTASH_BRIDGE_DIR: directory },
      input: Buffer.concat([header, payload]), timeout: 5_000,
    });
    assert.ifError(reply.error);
    assert.equal(reply.stdout.readUInt32LE(), reply.stdout.length - 4);
    return { exit: reply.status, response: JSON.parse(reply.stdout.subarray(4).toString('utf8')) };
  }
  const status = exchange(request);
  assert.equal(status.exit, 0);
  assert.equal(status.response.request_id, request.request_id);
  assert.equal(status.response.shared_auth, false);
  const credentials = exchange({ ...request, refresh_token: 'never-send-real-credentials' });
  assert.equal(credentials.exit, 1);
  assert.equal(credentials.response.code, 'invalid_status_request');
  console.log('正式 Host 状态消息往返通过；空请求和携带凭据的请求仍拒绝。此测试没有注册 Host，不能代替真实 Chrome 验收。');
} finally {
  await rm(directory, { recursive: true, force: true });
}
