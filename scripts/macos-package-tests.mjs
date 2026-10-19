import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { buildMacPackage, expandMacPackage, macInstallerName } from './macos-package.mjs';
import { packageEntries } from './release-package.mjs';

const mac = process.platform === 'darwin';
const version = JSON.parse(readFileSync(new URL('../companion/package.json', import.meta.url), 'utf8')).version;
const installer = fileURLToPath(new URL(`../companion/src-tauri/target/release/bundle/pkg/${macInstallerName(version)}`, import.meta.url));

test('Windows 发行清单保持中文 NSIS 安装机制和五项结构', () => {
  assert.deepEqual(packageEntries('0.6.0', true), ['Chrome Extension', 'README.txt', 'WindowStash-v0.6.0-Windows-x64-setup.exe', '初始化数据库.sql', '开始使用.html'].sort());
  assert(packageEntries('0.6.0', false).includes('WindowStash-v0.6.0-macOS-arm64-setup.pkg'));
  assert(!packageEntries('0.6.0', false).includes('WindowStash Companion.app'));
});

for (const stubborn of [false, true]) {
  test(`安装进程筛选隔离测试：${stubborn ? '超时停止且不强杀' : '仅终止目标应用的两个进程'}`, { skip: !mac }, t => {
    const directory = mkdtempSync(join(tmpdir(), 'windowstash-process-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const log = join(directory, 'signals');
    const snapshot = `123 /Applications/WindowStash Companion.app/Contents/MacOS/windowstash-companion
456 /Applications/WindowStash Companion.app/Contents/MacOS/windowstash-native-host
789 /tmp/WindowStash Companion.app/Contents/MacOS/windowstash-companion
901 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
902 /Applications/WindowStash Companion.app/Contents/MacOS/windowstash-native-host-other`;
    const fakePs = join(directory, 'ps');
    writeFileSync(fakePs, `#!/bin/sh\n${stubborn ? '' : `[ ! -e '${log}' ] || exit 0\n`}cat <<'SNAPSHOT'\n${snapshot}\nSNAPSHOT\n`, { mode: 0o755 });
    const fakeKill = join(directory, 'kill');
    writeFileSync(fakeKill, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
    const helper = readFileSync(new URL('./macos-installer/processes.sh', import.meta.url), 'utf8')
      .replaceAll('/bin/ps', fakePs).replaceAll('/bin/kill', fakeKill).replaceAll('/bin/sleep 1', ':');
    const result = spawnSync('/bin/sh', ['-s'], { input: `${helper}\nstop_installed_processes\n`, encoding: 'utf8' });
    assert.equal(result.status, stubborn ? 1 : 0, result.stderr);
    const signals = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual([...new Set(signals)], ['-TERM 123', '-TERM 456']);
    assert.equal(signals.length, stubborn ? 20 : 2);
    if (stubborn) assert.match(result.stderr, /Installation stopped/);
  });
}

test('安装脚本语法有效', { skip: !mac }, () => {
  for (const name of ['preinstall', 'postinstall', 'processes.sh']) {
    execFileSync('/bin/sh', ['-n', fileURLToPath(new URL(`./macos-installer/${name}`, import.meta.url))]);
  }
});

test('实包验证拒绝版本错配、错误安装位置及缺失 Host，失败不覆盖已有安装包', { skip: !mac || !existsSync(installer) }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'windowstash-package-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const payload = expandMacPackage(installer, join(directory, 'valid'), version);
  assert(existsSync(join(payload, 'WindowStash Companion.app/Contents/MacOS/windowstash-native-host')));
  assert.throws(() => expandMacPackage(installer, join(directory, 'wrong-version'), '99.99.99'), /版本或安装位置/);
  const original = readFileSync(installer);
  rmSync(join(payload, 'WindowStash Companion.app/Contents/MacOS/windowstash-native-host'));
  assert.throws(() => buildMacPackage(join(payload, 'WindowStash Companion.app'), installer, version), /清单不正确/);
  assert(readFileSync(installer).equals(original));
  // Damage a temporary copy, never the built package or installed application.
  const expanded = join(directory, 'raw');
  execFileSync('/usr/sbin/pkgutil', ['--expand', installer, expanded]);
  const component = join(expanded, 'Companion.pkg');
  const info = join(component, 'PackageInfo');
  writeFileSync(info, readFileSync(info, 'utf8').replace('install-location="/Applications"', 'install-location="/tmp"'), 'utf8');
  const corrupt = join(directory, 'corrupt.pkg');
  execFileSync('/usr/sbin/pkgutil', ['--flatten', expanded, corrupt]);
  assert.throws(() => expandMacPackage(corrupt, join(directory, 'invalid'), version), /版本或安装位置/);
});
