// Real Native Messaging frames against isolated expired-credential fixtures. No registration or cloud.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const target = process.env.TAURI_ENV_TARGET_TRIPLE;
const binary = fileURLToPath(new URL(`../companion/native-host/target/${target ? `${target}/` : ''}release/windowstash-native-host${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'windowstash-local-library-test-'));
const origin = `chrome-extension://${'a'.repeat(32)}/`;
const id = 'a'.repeat(64);
const capability = 'c'.repeat(64);
const project = 'https://fixture.supabase.co';
const workspaceId = '11111111-1111-4111-8111-111111111111';

function exchange(message, caller = origin) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  const result = spawnSync(binary, [caller], { env: { ...process.env, WINDOWSTASH_BRIDGE_DIR: root }, input: Buffer.concat([header, payload]), timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.stdout.readUInt32LE(), result.stdout.length - 4);
  return JSON.parse(result.stdout.subarray(4).toString('utf8'));
}
function messages(snapshot, revision) {
  const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const chunks = Math.ceil(bytes.length / 16_384);
  return Array.from({ length: chunks }, (_, index) => ({ version: 1, type: 'workspaces', instance_id: id, capability,
    project_url: project, user_id: 'fixture-user', revision, chunks, index, part: bytes.subarray(index * 16_384, (index + 1) * 16_384).toString('hex') }));
}
async function library() {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(join(root, 'workspace-library'), { withFileTypes: true });
  const scope = entries.find(entry => entry.isDirectory());
  return JSON.parse(await readFile(join(root, 'workspace-library', scope.name, 'library.json'), 'utf8'));
}
try {
  await mkdir(join(root, 'accounts'), { mode: 0o700 });
  await writeFile(join(root, 'accounts', `${id}.json`), JSON.stringify({ instance_id: id, origin, route_id: 'b'.repeat(64), capability,
    login_request: 'd'.repeat(64), config: { url: project, publishable_key: 'fixture' }, session: { user: { id: 'fixture-user' }, expires_at: 0 }, revision: 1 }), { encoding: 'utf8', mode: 0o600 });
  const record = { content: { id: workspaceId, name: 'Offline local', status: 'active', tabs: [{ title: '离线'.repeat(8_000), url: 'https://example.invalid', favIconUrl: 'https://example.invalid/favicon.ico', position: 0, pinned: false }], activeTabIndex: 0, createdAt: '2026-10-14', updatedAt: '2026-10-14' },
    sync: { syncStatus: 'pending', lastSyncedAt: null, lastSyncedHash: null, lastSyncedCloudUpdatedAt: null, localExpiresAt: '2026-11-14', lastSyncError: null } };
  const parts = messages({ records: [record], deleted: [] }, 1);
  assert(parts.length > 1);
  for (const [index, part] of parts.entries()) {
    assert.equal(exchange(part).status, index === parts.length - 1 ? 'persisted' : 'staged');
  }
  assert.equal((await library()).records[workspaceId].content.name, 'Offline local');
  assert.equal((await library()).records[workspaceId].content.tabs[0].favIconUrl, 'https://example.invalid/favicon.ico');
  assert.equal(exchange({ ...messages({ records: [], deleted: [] }, 2)[0], capability: 'e'.repeat(64) }).code, 'unauthorized_instance');
  assert.equal(exchange({ ...messages({ records: [], deleted: [] }, 2)[0], user_id: 'another-user' }).code, 'wrong_account');
  assert.equal(exchange(messages({ records: [], deleted: [workspaceId] }, 2)[0]).status, 'persisted');
  for (const part of messages({ records: [record], deleted: [] }, 3)) exchange(part);
  assert.equal(Object.keys((await library()).records).length, 0);
  assert.equal(exchange(parts[0]).code, 'stale_workspace_revision');
  console.log('本机工作区正式 Host 帧往返、跨进程持久化、分块、过期令牌离线授权、账号隔离及本机删除防复活通过；未注册或替换任何组件。');
} finally {
  await rm(root, { recursive: true, force: true });
}
