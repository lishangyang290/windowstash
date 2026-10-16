import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const windows = process.platform === 'win32';
const helper = resolve('companion/src-tauri/windows/installer-update.ps1');
const host = resolve('companion/src-tauri/binaries/windowstash-native-host-x86_64-pc-windows-msvc.exe');
const main = resolve('companion/src-tauri/target/x86_64-pc-windows-msvc/release/windowstash-companion.exe');
const names = ['windowstash-companion.exe', 'windowstash-native-host.exe'];
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture() {
  assert.ok(existsSync(host) && existsSync(main), 'Use existing Windows release binaries; do not silently skip installation checks.');
  const root = mkdtempSync(join(tmpdir(), 'windowstash-install-test-'));
  const install = join(root, 'original application'), source = join(root, 'source');
  mkdirSync(install); mkdirSync(source);
  for (const [i, name] of names.entries()) {
    copyFileSync(i ? host : main, join(source, name));
    copyFileSync(join(source, name), join(install, name));
    // Different content, identical PE versions. Overlay bytes don't change executable behavior.
    writeFileSync(join(install, name), Buffer.concat([readFileSync(join(install, name)), Buffer.from('previous-build')]));
  }
  const sentinel = join(install, 'untouched-user-data'); writeFileSync(sentinel, 'preserve');
  return { root, install, source, sentinel };
}
function run(phase, f) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-Phase', phase, '-InstallDirectory', f.install, '-SourceDirectory', f.source], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.ifError(result.error);
  return result;
}
function cleanup(f) {
  const actual = realpathSync(f.root), temporary = realpathSync(tmpdir());
  assert.ok(actual.startsWith(temporary + sep) && actual.includes('windowstash-install-test-'));
  rmSync(actual, { recursive: true, force: true });
}
async function waitingHost(file, root) {
  const child = spawn(file, ['chrome-extension://' + 'a'.repeat(32) + '/'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WINDOWSTASH_BRIDGE_DIR: join(root, 'never-create-private-data') },
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  await delay(200);
  assert.equal(child.exitCode, null);
  return { child, close: async () => { child.stdin.end(); await exited; } };
}

test('official installer hooks replace occupied same-version payloads, without killing either Host or touching data', { skip: !windows }, async () => {
  const f = fixture(), unrelated = join(f.root, 'unrelated'); mkdirSync(unrelated);
  copyFileSync(host, join(unrelated, names[1]));
  const old = await waitingHost(join(f.install, names[1]), f.root);
  const foreign = await waitingHost(join(unrelated, names[1]), f.root);
  let fresh;
  try {
    const script = join(f.root, 'installer.nsi'), executable = join(f.root, 'installer.exe');
    writeFileSync(script, `Unicode true\n!include LogicLib.nsh\nName "WindowStash installer test"\nOutFile "${executable}"\nRequestExecutionLevel user\nSilentInstall silent\nInstallDir "${f.install}"\n!define MAINBINARYSRCPATH "${main}"\n!include "${resolve('companion/src-tauri/windows/installer-hooks.nsh')}"\nSection\nSetOutPath $INSTDIR\n!insertmacro NSIS_HOOK_PREINSTALL\nFile "${main}"\nFile /a /oname=windowstash-native-host.exe "${host}"\n!insertmacro NSIS_HOOK_POSTINSTALL\nSectionEnd\n`, 'utf8');
    const compile = spawnSync(join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe'), ['/V1', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const installer = spawn(executable, ['/S'], { windowsHide: true, stdio: 'ignore' });
    const finished = new Promise((resolve, reject) => { installer.once('exit', resolve); installer.once('error', reject); });
    const deadline = Date.now() + 30_000;
    let reconnectedDuringInstall = false;
    while (installer.exitCode === null && Date.now() < deadline) {
      try {
        if (!fresh && existsSync(join(f.install, names[1])) && hash(join(f.install, names[1])) === hash(host)) {
          reconnectedDuringInstall = true;
          fresh = await waitingHost(join(f.install, names[1]), f.root);
        }
      } catch (error) { if (!['ENOENT', 'EBUSY', 'EACCES'].includes(error.code)) throw error; }
      await delay(10);
    }
    assert.ok(Date.now() < deadline, 'Installer must finish without waiting for Chrome to close.');
    assert.equal(await finished, 0);
    for (const [i, name] of names.entries()) assert.equal(hash(join(f.install, name)), hash(i ? host : main));
    assert.ok(reconnectedDuringInstall, 'Chrome can start the new Host while the post-install check is running.');
    assert.equal(old.child.exitCode, null); assert.equal(foreign.child.exitCode, null);
    assert.equal(readFileSync(f.sentinel, 'utf8'), 'preserve');
    assert.equal(existsSync(join(f.root, 'never-create-private-data')), false);
  } finally { await fresh?.close(); await old.close(); await foreign.close(); cleanup(f); }
});

test('verification rejects an old or truncated Host instead of reporting successful installation', { skip: !windows }, () => {
  const f = fixture();
  try {
    assert.equal(run('Prepare', f).status, 0);
    copyFileSync(join(f.source, names[0]), join(f.install, names[0]));
    writeFileSync(join(f.install, names[1]), 'truncated');
    const result = run('Verify', f);
    assert.equal(result.status, 20); assert.match(result.stdout, /does not match/);
    assert.equal(readFileSync(f.sentinel, 'utf8'), 'preserve');
  } finally { cleanup(f); }
});

test('preparation with a missing payload leaves existing executable files intact', { skip: !windows }, () => {
  const f = fixture(), missing = join(f.root, 'missing'); mkdirSync(missing);
  try {
    const before = names.map(name => hash(join(f.install, name)));
    const result = run('Prepare', { ...f, source: missing });
    assert.equal(result.status, 20);
    assert.deepEqual(names.map(name => hash(join(f.install, name))), before);
    assert.equal(readdirSync(f.install).some(name => name.includes('.previous-')), false);
  } finally { cleanup(f); }
});

test('graceful shutdown arguments and native identity work in installer Windows PowerShell', { skip: !windows }, () => {
  const script = readFileSync(helper, 'utf8');
  const code = script.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  const argumentsCode = script.match(/      \$ids = [^\r\n]+\r?\n      \$starts = [^\r\n]+/)[0];
  const command = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${code}\n'@\n$companions = @([pscustomobject]@{ProcessId=$PID})\n${argumentsCode}\n$ids.GetType().FullName\n$starts.GetType().FullName\n[Runtime.InteropServices.Marshal]::SizeOf([type][WindowStashInstallerRestart+Application])`;
  for (const executable of ['System32', 'SysWOW64'].map(dir => join(process.env.WINDIR, dir, 'WindowsPowerShell/v1.0/powershell.exe'))) {
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['System.UInt32[]', 'System.Int64[]', '12']);
  }
});
