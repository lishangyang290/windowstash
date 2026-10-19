import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { command, npmInvocation, parseRelease, validateInput, planFiles, applyFiles, restoreFiles, saveJournal, recoverPrepared, preflight, checkRemote, runChecks, publish, recoveryPlan, inspectRelease, readOnlyQueries, retryReadOnly } from './release-core.mjs';
import { terminalUI, presentedCommand, workflowProgress, liveProgress } from './release-ui.mjs';
import { inputLines, editRelease, showResult, recoverRelease, handleReleaseState } from './release.mjs';
import { copyReleaseSql, validateReleaseSql, releaseSqlFiles, packageEntries, validateGuidePackageTrees } from './release-package.mjs';

const root = resolve(import.meta.dirname, '..');
const standard = '当前版本：v0.3.0\n目标版本：0.4.0\n\n更新内容：\n- 修复重启后关联丢失\n- 新增教程入口\n\nmain HEAD：\n56b8e2fe30517972e54cfe9a5ba4befd822f924c\n测试：\n224 项通过';
const silent = new Writable({ write(chunk, encoding, done) { done(); } });
const releaseAssets = () => ['macOS-arm64.zip', 'Windows-x64.zip'].map((suffix) => ({ name: `WindowStash-v0.4.0-${suffix}`, size: 100, url: 'https://example.test/download.zip' }));
const fastRetries = { sleep: async () => {}, notify: () => {} };

for (const [windows, version] of [[true, '0.6.0'], [false, '7.8.9']]) {
  test(`SQL 完整 ZIP 保留仓库原始字节及教程目录：${windows ? 'Windows' : 'macOS'}`, async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'windowstash-sql-package-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const packageRoot = resolve(directory, `WindowStash-v${version}`);
    const archive = resolve(directory, 'fixture.zip'), extracted = resolve(directory, 'extracted');
    await copyReleaseSql(packageRoot);
    const guide = (await readFile(resolve(root, 'public/开始使用.html'), 'utf8')).replace(/WindowStash-v\d+\.\d+\.\d+/g, `WindowStash-v${version}`);
    validateGuidePackageTrees(guide, version);
    assert.throws(() => validateGuidePackageTrees(guide.replace(`WindowStash-v${version}-macOS-arm64-setup.pkg`, 'WindowStash Companion.app'), version), /不一致/);
    await writeFile(resolve(packageRoot, '开始使用.html'), guide, 'utf8');
    await writeFile(resolve(packageRoot, 'README.txt'), 'fixture', 'utf8');
    await mkdir(resolve(packageRoot, 'Chrome Extension'));
    await writeFile(resolve(packageRoot, 'Chrome Extension/manifest.json'), JSON.stringify({ version }), 'utf8');
    if (windows) await writeFile(resolve(packageRoot, `WindowStash-v${version}-Windows-x64-setup.exe`), 'fixture');
    else await writeFile(resolve(packageRoot, `WindowStash-v${version}-macOS-arm64-setup.pkg`), 'fixture');
    assert.deepEqual((await readdir(packageRoot)).sort(), packageEntries(version, windows));
    validateReleaseSql(packageRoot);
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $package = $env:SQL_PACKAGE_ROOT
        $zip = [IO.Compression.ZipFile]::Open($env:SQL_ARCHIVE, 'Create')
        function Add-PackageFiles($folder, $prefix) {
          Get-ChildItem -LiteralPath $folder | ForEach-Object {
            $entry = $prefix + '/' + $_.Name
            if ($_.PSIsContainer) { Add-PackageFiles $_.FullName $entry }
            else { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry) }
          }
        }
        try { Add-PackageFiles $package (Split-Path $package -Leaf) }
        finally { $zip.Dispose() }
        $zip = [IO.Compression.ZipFile]::OpenRead($env:SQL_ARCHIVE)
        try {
          $prefix = (Split-Path $package -Leaf) + '/'
          foreach ($entry in $zip.Entries) {
            if (!$entry.FullName.StartsWith($prefix) -or $entry.FullName.Contains([char]92)) {
              throw ('ZIP member path is invalid: ' + $entry.FullName)
            }
          }
        } finally { $zip.Dispose() }
        [IO.Compression.ZipFile]::ExtractToDirectory($env:SQL_ARCHIVE, $env:SQL_EXTRACTED)
      `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SQL_PACKAGE_ROOT: packageRoot, SQL_ARCHIVE: archive, SQL_EXTRACTED: extracted } })
      : spawnSync('ditto', ['-c', '-k', '--keepParent', packageRoot, archive], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (process.platform !== 'win32') {
      const unpack = spawnSync('ditto', ['-x', '-k', archive, extracted], { encoding: 'utf8' });
      assert.equal(unpack.status, 0, unpack.stderr);
    }
    const unpackedRoot = resolve(extracted, `WindowStash-v${version}`);
    validateReleaseSql(unpackedRoot);
    assert.deepEqual((await readdir(unpackedRoot)).sort(), packageEntries(version, windows));
    for (const [destination, source] of Object.entries(releaseSqlFiles)) {
      assert((await readFile(resolve(unpackedRoot, destination))).equals(await readFile(resolve(root, source))), destination);
    }
    await writeFile(resolve(unpackedRoot, '初始化数据库.sql'), '\n', { flag: 'a' });
    assert.throws(() => validateReleaseSql(unpackedRoot), /不一致/);
    assert.throws(() => validateGuidePackageTrees(guide.replace('├── 初始化数据库.sql', '├── missing.sql'), version), /不一致/);
  });
}

test('SQL 校验拒绝缺失、改动及多余文件', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'windowstash-sql-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyReleaseSql(directory);
  for (const destination of Object.keys(releaseSqlFiles)) {
    const path = resolve(directory, destination), original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => validateReleaseSql(directory), /不一致/);
    await rm(path);
    assert.throws(() => validateReleaseSql(directory));
    await writeFile(path, original);
  }
  await writeFile(resolve(directory, 'unexpected.sql'), '');
  assert.throws(() => validateReleaseSql(directory), /清单不正确/);
  await rm(resolve(directory, 'unexpected.sql'));
  await mkdir(resolve(directory, '旧版本升级'));
  assert.throws(() => validateReleaseSql(directory), /清单不正确/);
});

for (const target of ['', 'aarch64-apple-darwin', 'x86_64-pc-windows-msvc']) {
  test(`正式 Host 路径使用目标架构，避免读取默认目录中的旧程序：${target || '本机默认'}`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { nativeHostTarget, nativeHostBinary } from "./scripts/native-host-paths.mjs"; console.log(JSON.stringify({ target: nativeHostTarget, binary: nativeHostBinary }))'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, TAURI_ENV_TARGET_TRIPLE: target } });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    const expected = target || spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout.match(/^host: (.+)$/m)?.[1];
    assert.ok(expected);
    assert.equal(actual.target, expected);
    assert.equal(actual.binary, resolve(root, 'companion/native-host/target', expected, 'release', `windowstash-native-host${expected.includes('windows') ? '.exe' : ''}`));
  });
}

async function processMock(directory, hash, scenario = '') {
  // Mock only child processes in the isolated fixture, identically on both OSes.
  await writeFile(resolve(directory, 'fetch-mock.mjs'), `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync, appendFileSync } from 'node:fs';
globalThis.fetch = async () => ({status:404});
const original = childProcess.spawn, scenario = ${JSON.stringify(scenario)}, hash = ${JSON.stringify(hash)};
let statuses = 0;
childProcess.spawn = (program, args, options) => {
 let code, output = '';
 if (program === 'git') {
  if (args[0] === 'ls-remote') { code = 0; if(args.includes('--exit-code')) output = hash + '\\trefs/heads/main\\n'; }
  if (args[0] === 'push') { appendFileSync('push.log', args.join(' ') + '\\n'); code = ['tagPushFailure','tagCreationFailure'].includes(scenario) && args.at(-1).endsWith(':refs/heads/main') ? 0 : 1; }
  if (scenario === 'commitFailure' && args[0] === 'commit') code = 1;
  if (scenario === 'tagCreationFailure' && args[0] === 'tag' && args[1] !== '--list') code = 1;
  if (scenario === 'journalRace' && args[0] === 'status' && ++statuses === 3) writeFileSync('.windowstash-release.json', '{"owner":"other"}\\n', 'utf8');
 }
 if (program === 'npm' || args[0]?.endsWith('npm-cli.js')) code = scenario === 'testFailure' && args.includes('test') ? 1 : 0;
 if (code === undefined) return original(program, args, options);
 const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
 process.nextTick(() => { child.stdout.end(output); child.stderr.end(); child.emit('close', code); });
 return child;
};
syncBuiltinESMExports();
`, 'utf8');
}

test('npm Windows 调用保留参数边界，其他平台继续直接调用 npm', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'windowstash npm 中文 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = resolve(directory, 'npm-cli.js');
  await writeFile(cli, 'console.log(JSON.stringify(process.argv.slice(2)))', 'utf8');
  const args = ['空 格', '中文', '& echo injected', '%PATH%', '"quoted"', '$(bad)', ''];
  const [program, parameters] = npmInvocation(args, 'win32', { npm_execpath: cli });
  assert.equal(program, process.execPath);
  assert.deepEqual(JSON.parse(await command(root)(program, parameters)), args);
  assert.deepEqual(npmInvocation(args, 'darwin'), ['npm', args]);
  assert.throws(() => npmInvocation([], 'win32', {}, resolve(directory, 'node.exe')), /无法定位 npm-cli/);
});

test('当前平台 npm、Git、Node 直接调用可用，并保留失败状态', async () => {
  const run = command(root);
  assert.match(await run('npm', ['--version']), /^\d+\.\d+\.\d+$/);
  assert.match(await run('git', ['--version']), /git version/);
  assert.match(await run(process.execPath, ['--version']), /^v\d+/);
  await assert.rejects(run('npm', ['run', '__windowstash_missing_script__']), /失败/);
});

test('ESM --import 使用 file URL，兼容中文、空格、# 和 % 文件名', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'windowstash ESM 中文 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = resolve(directory, 'mock #%.mjs');
  await writeFile(module, 'process.env.WINDOWSTASH_IMPORT_TEST="已加载";', 'utf8');
  assert.equal(await command(root)(process.execPath, ['--import', pathToFileURL(module).href, '-e', 'console.log(process.env.WINDOWSTASH_IMPORT_TEST)']), '已加载');
});

test('Windows 双击入口定位带空格中文路径，传参并保留退出码', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'WindowStash 启动 (&) ! '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(resolve(root, 'WindowStash Release.cmd'), resolve(directory, 'WindowStash Release.cmd'));
  for (const path of ['scripts', 'node_modules/marked', 'companion/node_modules/@tauri-apps/cli']) await mkdir(resolve(directory, path), { recursive: true });
  for (const path of ['node_modules/marked/package.json', 'companion/node_modules/@tauri-apps/cli/package.json']) await writeFile(resolve(directory, path), '{}', 'utf8');
  await writeFile(resolve(directory, 'scripts/release.mjs'), 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));process.exitCode=7;', 'utf8');
  const { spawnSync } = await import('node:child_process');
  const launcher = await readFile(resolve(directory, 'WindowStash Release.cmd'), 'utf8');
  assert.doesNotMatch(launcher, /(?<!\r)\n/);
  assert.match(await readFile(resolve(root, '.gitattributes'), 'utf8'), /"WindowStash Release.cmd" text eol=crlf/);
  for (const args of ['', '--help', '--dry-run --verbose', '--restore']) {
    const result = spawnSync('cmd.exe', ['/d', '/c', `""${resolve(directory, 'WindowStash Release.cmd')}" ${args}"`], { cwd: root, input: '\n', encoding: 'utf8', windowsVerbatimArguments: true });
    assert.ifError(result.error);
    assert.equal(result.status, 7, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(JSON.stringify({ cwd: directory, args: args ? args.split(' ') : [] })), result.stdout);
    assert.match(result.stdout, /运行已结束/);
  }
  await rm(resolve(directory, 'node_modules/marked/package.json'));
  const missing = spawnSync('cmd.exe', ['/d', '/c', `""${resolve(directory, 'WindowStash Release.cmd')}""`], { input: '\n', encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /缺少项目依赖/);
});

for (const scenario of ['macOnly', 'windowsOnly', 'extraInstaller', 'extraPkg', 'extraFile', 'duplicate', 'emptyWindows', 'draft', 'prerelease', 'failed', 'complete']) test(`双平台正式发布完整性：${scenario}`, async () => {
  const harness = resultHarness();
  await showResult(async (program, args) => {
    if (args[0] === 'auth') return '';
    if (args[0] === 'run') {
      const workflow = actionRun('completed', scenario === 'failed' ? 'failure' : 'success');
      return JSON.stringify(args[1] === 'list' ? [workflow] : workflow);
    }
    let assets = releaseAssets();
    if (scenario === 'macOnly') assets = assets.slice(0, 1);
    if (scenario === 'windowsOnly') assets = assets.slice(1);
    if (scenario.startsWith('extra')) assets.push({ name: scenario === 'extraInstaller' ? 'WindowStash-v0.4.0-Windows-x64-setup.exe' : scenario === 'extraPkg' ? 'WindowStash-v0.4.0-macOS-arm64-setup.pkg' : 'unexpected.txt', size: 100 });
    if (scenario === 'duplicate') assets.push(assets[0]);
    if (scenario === 'emptyWindows') assets[1].size = 0;
    return JSON.stringify({ isDraft: scenario === 'draft', isPrerelease: scenario === 'prerelease', assets });
  }, '0.4.0', 'abc', harness.options);
  assert.equal(harness.messages.some((text) => text.includes('发布成功')), scenario === 'complete');
  assert.ok(!harness.messages.some((text) => text.includes('Windows 安装程序')));
});

test('PR 与手动 Actions 验证没有写权限或发布路径，只有成功的 Tag 发布任务可写', async () => {
  const source = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /pull_request:\s+branches: \[main\]\s+types: \[opened, synchronize, reopened\]/);
  assert.doesNotMatch(source, /pull_request_target|secrets\./);
  assert.match(source, /permissions:\s+contents: read/);
  const [build, publish] = source.split('\n  publish:');
  assert.doesNotMatch(build, /contents: write|gh release|publish-release\.mjs/);
  assert.match(publish, /needs: build/);
  assert.match(publish, /if: github.event_name == 'push' && github.ref_type == 'tag' && startsWith\(github.ref, 'refs\/tags\/v'\) && needs.build.result == 'success'/);
  assert.match(build, /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
  assert.match(build, /github.event_name == 'push' && 'release' \|\| 'validation'/);
  assert.match(build, /path: \$\{\{ runner.temp \}\}\/release-assets\/WindowStash-v\$\{\{ env.RELEASE_VERSION \}\}-\$\{\{ matrix.artifact \}\}\.zip/);
  assert.match(publish, /contents: write/);
  assert.equal((source.match(/run: node scripts\/publish-release.mjs/g) ?? []).length, 1);
});

test('组装脚本将安装器保留在 ZIP 内，输出目录仅生成平台 ZIP 且必须通过实包校验', async () => {
  const source = await readFile(resolve(root, 'scripts/assemble-release.mjs'), 'utf8');
  assert.match(source, /copyFile\(join\(bundle, installers\[0\]\), join\(packageDir, installer\)\)/);
  assert.match(source, /buildMacPackage\([^\n]+join\(packageDir, macInstallerName\(version\)\)/);
  assert.doesNotMatch(source, /join\(output, installer\)/);
  assert.match(source, /join\(output, `\$\{name\}-\$\{windows \? 'Windows-x64' : 'macOS-arm64'\}\.zip`\)/);
  assert.match(source, /'scripts\/validate-release-artifact.mjs', packageDir, zipPath, version/);
});

for (const scenario of ['success', 'existing', 'uploadFailure', 'missingAsset', 'extraAsset', 'wrongSize', 'corruptDownload', 'wrongTag', 'manual', 'pr', 'localMissing', 'localExtra', 'localEmpty']) test(`统一发布任务安全流程（完全模拟 gh）：${scenario}`, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'windowstash-publish-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = releaseAssets().map((asset) => asset.name).sort();
  await mkdir(resolve(directory, 'release-assets'));
  await mkdir(resolve(directory, '.github/release-notes'), { recursive: true });
  for (const name of names) await writeFile(resolve(directory, 'release-assets', name), 'fixture artifact', 'utf8');
  if (scenario === 'localMissing') await rm(resolve(directory, 'release-assets', names[0]));
  if (scenario === 'localExtra') await writeFile(resolve(directory, 'release-assets/WindowStash-v0.4.0-Windows-x64-setup.exe'), 'fixture', 'utf8');
  if (scenario === 'localEmpty') await writeFile(resolve(directory, 'release-assets', names[0]), '', 'utf8');
  await writeFile(resolve(directory, '.github/release-notes/v0.4.0.md'), '- 模拟更新说明\n', 'utf8');
  const mock = resolve(directory, 'gh-mock.mjs');
  await writeFile(mock, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const scenario = ${JSON.stringify(scenario)}, names = ${JSON.stringify(names)};
childProcess.spawnSync = (program, args) => {
 if (program !== 'gh') throw new Error('禁止未模拟的进程');
 appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n', 'utf8');
 const ok = (value = '') => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
 const fail = (stderr) => ({ status: 1, stdout: '', stderr });
 if (args[0] === 'api') {
  if (args[1].includes('/git/ref/')) return ok({object:{type:'commit',sha:(scenario === 'wrongTag' ? 'b' : 'a').repeat(40)}});
  return scenario === 'existing' ? ok({id:1}) : fail('gh: Not Found (HTTP 404)');
 }
 if (args[1] === 'upload' && scenario === 'uploadFailure') return fail('upload failed');
 if (args[1] === 'create') writeFileSync('body.md', readFileSync(args[args.indexOf('--notes-file')+1]));
 if (args[1] === 'view') return ok({isDraft:true,isPrerelease:false,assets:(scenario === 'missingAsset' ? names.slice(1) : scenario === 'extraAsset' ? [...names, 'unexpected.exe'] : names).map(name => ({name,size:scenario === 'wrongSize' ? 17 : 16}))});
 if (args[1] === 'download') {
  const destination = args[args.indexOf('--dir')+1]; mkdirSync(destination);
  for (const name of names) writeFileSync(join(destination,name), scenario === 'corruptDownload' ? 'corrupt artifact' : 'fixture artifact', 'utf8');
 }
 return ok();
};
syncBuiltinESMExports();
`, 'utf8');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, resolve(root, 'scripts/publish-release.mjs')], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: scenario === 'pr' ? 'pull_request' : scenario === 'manual' ? 'workflow_dispatch' : 'push', GITHUB_REF: 'refs/tags/v0.4.0', GITHUB_REF_NAME: 'v0.4.0', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'lishangyang290/windowstash' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stderr);
  const calls = ['manual', 'pr', 'localMissing', 'localExtra', 'localEmpty'].includes(scenario) ? [] : (await readFile(resolve(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[1] === 'edit'), scenario === 'success');
  assert.ok(calls.every((args) => !args.includes('--clobber')));
  if (['existing', 'wrongTag', 'manual', 'pr', 'localMissing', 'localExtra', 'localEmpty'].includes(scenario)) assert.ok(!calls.some((args) => args[1] === 'create'));
  else assert.ok(calls.find((args) => args[1] === 'create')?.includes('--draft'));
  if (scenario === 'success') {
    const upload = calls.find((args) => args[1] === 'upload');
    assert.deepEqual(upload.slice(3, upload.indexOf('--repo')).map((path) => path.split(/[\\/]/).at(-1)).sort(), names);
    const body = await readFile(resolve(directory, 'body.md'), 'utf8');
    assert.equal((body.match(/https:\/\/github.com\/[^)]+\/releases\/download\//g) ?? []).length, 2);
    assert.doesNotMatch(body, /setup\.exe|setup\.pkg/);
    assert.deepEqual(calls.filter((args) => args[0] === 'release').map((args) => args[1]), ['create', 'upload', 'view', 'download', 'edit']);
    assert.ok(calls.at(-1).includes('--draft=false'));
  }
});

test('Actions 进度只统计真实步骤，区分成功、跳过和失败，支持并行 Job', () => {
  const lines = workflowProgress({ status: 'in_progress', jobs: [
    { name: 'Extension', status: 'in_progress', steps: [{ name: '检查', status: 'completed', conclusion: 'success' }, { name: '构建', status: 'in_progress' }] },
    { name: 'Companion', status: 'in_progress', steps: [{ name: '跳过', status: 'completed', conclusion: 'skipped' }, { name: '失败', status: 'completed', conclusion: 'failure' }, { name: '打包', status: 'in_progress' }] },
  ] });
  assert.match(lines[1], /已结束 3\/5（成功 1，跳过 1，未成功 1）/);
  assert.match(lines[2], /Extension · 构建；Companion · 打包/);
  assert.match(workflowProgress()[1], /进度未知/);
  assert.match(workflowProgress({ status: 'completed', jobs: [{ steps: [{ name: '上传 Release', status: 'completed', conclusion: 'failure' }] }] })[2], /上传 Release · failure/);
});

for (const [tty, term, noColor] of [[true, 'xterm', false], [false, 'xterm', false], [true, 'dumb', false], [true, 'xterm', true]]) {
  test(`进度区域 TTY=${tty} TERM=${term} NO_COLOR=${noColor}`, (t) => {
    const previous = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
    t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    process.env.TERM = term;
    if (noColor) process.env.NO_COLOR = ''; else delete process.env.NO_COLOR;
    const chunks = [], messages = [];
    const display = liveProgress({ isTTY: tty, columns: 38, write: (text) => chunks.push(text) }, (text) => messages.push(text));
    const lines = workflowProgress({ status: 'queued' });
    display.update(lines, 0); display.update(lines, 1000, true); display.update(lines, 12000);
    if (tty && term !== 'dumb' && !noColor) {
      assert.equal(chunks.length, 3); assert.ok(chunks[1].includes('\x1b[4A'));
      assert.match(chunks[1], /0 分 1 秒/); assert.equal(messages.length, 0);
      for (const row of chunks[0].replaceAll('\x1b', '').replace(/\[[\d;]*[AK]/g, '').trim().split('\n')) {
        assert.ok([...row.trim()].reduce((n, char) => n + (char.codePointAt(0) > 255 ? 2 : 1), 0) < 38);
      }
    } else {
      assert.equal(chunks.length, 0); assert.equal(messages.length, 2);
      assert.match(messages[1], /0 分 12 秒/); assert.ok(!messages.join('').includes('\x1b'));
    }
  });
}

function resultHarness() {
  const messages = [], snapshots = [];
  let clock = 0;
  return { messages, snapshots, options: {
    wait: true, ui: terminalUI({ isTTY: false }, (text) => messages.push(text)),
    display: { update: (lines, elapsed) => snapshots.push({ lines, elapsed }) },
    now: () => clock, sleep: async (ms) => { clock += ms; },
  } };
}
const actionRun = (status = 'in_progress', conclusion = null) => ({ databaseId: 123, status, conclusion, headBranch: 'v0.4.0', headSha: 'abc', url: 'https://example.test/actions', jobs: [{ name: 'macOS', status, steps: [{ name: 'Validate Extension', status, conclusion }] }] });

test('Actions 每 12 秒查询 Job/Step，完成后校验 ZIP 并显示下载链接', async () => {
  const harness = resultHarness(), calls = [];
  let polls = 0, details = 0;
  await showResult(async (program, args, live, timeout) => {
    calls.push(args);
    assert.ok(timeout > 0 && timeout <= 30000);
    if (args[0] === 'auth') return '';
    if (args[1] === 'list') { polls++; return JSON.stringify([actionRun()]); }
    if (args[0] === 'run') { details++; return JSON.stringify(actionRun(details === 2 ? 'completed' : 'in_progress', details === 2 ? 'success' : null)); }
    return JSON.stringify({ url: 'https://example.test/release', isDraft: false, isPrerelease: false, assets: releaseAssets() });
  }, '0.4.0', 'abc', harness.options);
  assert.equal(polls, 1);
  assert.equal(details, 2);
  assert.ok(calls.filter((args) => args[1] === 'list').every((args) => args[args.indexOf('--event') + 1] === 'push'));
  assert.ok(calls.some((args) => args[1] === 'view' && args[2] === '123' && args.includes('status,conclusion,url,headBranch,headSha,jobs')));
  assert.ok(harness.snapshots.some(({ lines, elapsed }) => elapsed === 12000 && lines[1].includes('已结束 1/1')));
  assert.match(harness.messages.join('\n'), /发布成功[\s\S]*ZIP 下载.*download.zip/);
});

for (const scenario of ['network', 'timeout', 'foreignCommit', 'foreignTag', 'cancelled', 'emptyZip', 'prerelease']) test(`Actions 保留实际状态且禁止误报成功：${scenario}`, async () => {
  const harness = resultHarness(); let polls = 0, releaseQueries = 0, details = 0;
  if (scenario === 'timeout') harness.options.timeout = 12000;
  if (scenario === 'cancelled') harness.options.active = () => { if (polls) throw new Error('用户取消'); };
  if (scenario.startsWith('foreign')) harness.options.wait = false;
  await showResult(async (program, args) => {
    if (args[0] === 'auth') return '';
    if (args[1] === 'list') {
      polls++;
      const workflow = actionRun();
      if (scenario === 'foreignCommit') workflow.headSha = 'other';
      if (scenario === 'foreignTag') workflow.headBranch = 'v0.5.0';
      return JSON.stringify([workflow]);
    }
    if (args[0] === 'run') {
      if (scenario === 'network' && ++details === 2) throw new Error('network');
      return JSON.stringify(actionRun(['emptyZip', 'prerelease'].includes(scenario) ? 'completed' : 'in_progress', ['emptyZip', 'prerelease'].includes(scenario) ? 'success' : null));
    }
    releaseQueries++;
    return JSON.stringify({ isDraft: false, isPrerelease: scenario === 'prerelease', assets: [{ name: 'WindowStash-v0.4.0-macOS.zip', size: scenario === 'emptyZip' ? 0 : 100 }] });
  }, '0.4.0', 'abc', harness.options);
  assert.ok(!harness.messages.join('').includes('发布成功'));
  if (!['emptyZip', 'prerelease'].includes(scenario)) assert.equal(releaseQueries, 0);
  if (scenario === 'network') assert.match(harness.snapshots.at(-1).lines.join(' '), /构建中.*Extension 检查与构建/);
  if (scenario === 'timeout') assert.match(harness.messages.join(' '), /等待超时/);
});

test('gh 查询挂起会超时停止，命令包装保留查询超时参数', async () => {
  const ui = terminalUI({ isTTY: false }, () => {}), calls = [];
  await presentedCommand(async (...args) => { calls.push(args); }, ui)('gh', ['auth', 'status'], false, 50);
  assert.equal(calls[0][3], 50);
  await assert.rejects(command(root)(process.execPath, ['-e', 'setInterval(()=>{},1000)'], false, 50), /失败/);
});

for (const scenario of ['recover', 'continuous', 'queryTimeout', 'failed', 'success']) test(`进度查询重试及真实结果：${scenario}`, async () => {
  const harness = resultHarness(), calls = [];
  let details = 0;
  await showResult(async (program, args, live, timeout) => {
    assert.equal(program, 'gh'); calls.push(args);
    if (args[0] === 'auth') return '';
    if (args[1] === 'list') return JSON.stringify([actionRun()]);
    if (args[0] === 'run') {
      assert.equal(args[2], '123');
      details++;
      if ((scenario === 'recover' && details === 2) || (scenario === 'continuous' && details > 1)) throw new Error('ECONNRESET fixture connection');
      if (scenario === 'queryTimeout' && details > 1) {
        await harness.options.sleep(timeout);
        throw new Error('query timed out after fixture deadline');
      }
      const result = actionRun(details > 1 ? 'completed' : 'in_progress', details > 1 ? scenario === 'failed' ? 'failure' : 'success' : null);
      return JSON.stringify(result);
    }
    return JSON.stringify({ isDraft: false, isPrerelease: false, url: 'fixture', assets: releaseAssets() });
  }, '0.4.0', 'abc', { ...harness.options, timeout: 48000 });
  const messages = harness.messages.join('\n');
  assert.equal(calls.filter((args) => args[1] === 'list').length, 1);
  assert.ok(calls.every((args) => !['rerun', 'create', 'upload', 'edit'].includes(args[1])));
  assert.equal(messages.includes('发布成功'), ['recover', 'success'].includes(scenario));
  if (scenario === 'recover' || scenario === 'continuous') {
    assert.match(messages, /查询诊断.*ECONNRESET fixture connection/);
    assert.ok(harness.snapshots.some(({ lines }) => /正在重试.*构建中/.test(lines[0]) && lines[2].includes('Extension 检查与构建')));
  }
  if (['continuous', 'queryTimeout'].includes(scenario)) assert.match(messages, /等待超时/);
  if (scenario === 'queryTimeout') assert.match(messages, /query timed out after fixture deadline/);
  if (scenario === 'failed') {
    assert.match(messages, /构建未成功：failure/);
    assert.ok(harness.snapshots.some(({ lines }) => lines[2].includes('macOS · Extension 检查与构建 · failure')));
  }
});

for (const scenario of ['missing', 'unauthenticated', 'invalidToken', 'apiFailure']) test(`gh 不可用时仅用匿名公开 GET 跟踪：${scenario}`, async () => {
  const harness = resultHarness(), urls = [];
  let commands = 0;
  await showResult(async () => {
    commands++;
    if (scenario === 'missing') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    throw new Error(scenario === 'invalidToken' ? 'HTTP 401: token invalid' : 'You are not logged into any GitHub hosts');
  }, '0.4.0', 'abc', { ...harness.options, timeout: 24000, fetch: async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.method, undefined);
    assert.ok(options.signal);
    if (scenario === 'apiFailure') return { ok: false, status: 403, text: async () => 'API rate limit exceeded' };
    const workflow = { id: 123, status: 'completed', conclusion: 'success', head_branch: 'v0.4.0', head_sha: 'abc', html_url: 'fixture' };
    const value = url.includes('/workflows/') ? { workflow_runs: [workflow] }
      : url.includes('/jobs?') ? { jobs: [] }
        : url.includes('/releases/') ? { draft: false, prerelease: false, html_url: 'fixture', assets: releaseAssets().map((asset) => ({ ...asset, browser_download_url: asset.url })) } : workflow;
    return { ok: true, json: async () => value };
  } });
  assert.equal(commands, 1);
  assert.ok(urls.every((url) => url.startsWith('https://api.github.com/repos/lishangyang290/windowstash/')));
  assert.match(harness.messages.join('\n'), /查询诊断.*(?:ENOENT|not logged|HTTP 401)/);
  assert.equal(harness.messages.some((line) => line.includes('发布成功')), scenario !== 'apiFailure');
  if (scenario === 'apiFailure') assert.match(harness.messages.join('\n'), /等待超时[\s\S]*HTTP 403.*API rate limit exceeded/);
});

test('跟踪中认证失效后公开 API 仍查询原 Workflow，并保留失败步骤', async () => {
  const harness = resultHarness(), urls = [];
  let details = 0;
  await showResult(async (program, args) => {
    if (args[0] === 'auth') return '';
    if (args[1] === 'list') return JSON.stringify([actionRun()]);
    if (++details > 1) throw new Error('HTTP 401: Bad credentials');
    return JSON.stringify(actionRun());
  }, '0.4.0', 'abc', { ...harness.options, fetch: async (url) => {
    urls.push(url);
    return { ok: true, json: async () => url.includes('/jobs?')
      ? { jobs: [{ name: 'Windows x64', status: 'completed', conclusion: 'failure', steps: [{ name: 'Validate Extension', status: 'completed', conclusion: 'failure' }] }] }
      : { id: 123, status: 'completed', conclusion: 'failure', head_branch: 'v0.4.0', head_sha: 'abc', html_url: 'fixture' } };
  } });
  assert.ok(urls.every((url) => url.includes('/actions/runs/123')));
  assert.match(harness.messages.join('\n'), /构建未成功：failure[\s\S]*查询诊断.*HTTP 401: Bad credentials/);
  assert.ok(harness.snapshots.some(({ lines }) => lines[2].includes('Windows x64 · Extension 检查与构建 · failure')));
});

test('父 Workflow 状态不变时，Extension、Companion、ZIP、上传任务仍按真实 Step 更新', async () => {
  const harness = resultHarness(), names = ['Validate Extension', 'Build Companion app', 'Assemble macOS package', 'Create GitHub Release and upload macOS asset'];
  let index = -1;
  await showResult(async (program, args) => {
    if (args[0] === 'auth') return '';
    if (args[1] === 'list') return JSON.stringify([actionRun()]);
    if (args[0] === 'run') {
      index++;
      const workflow = actionRun(index === names.length ? 'completed' : 'in_progress', index === names.length ? 'success' : null);
      workflow.jobs[0].steps = names.map((name, i) => ({ name, status: i < index ? 'completed' : i === index ? 'in_progress' : 'queued', conclusion: i < index ? 'success' : null }));
      return JSON.stringify(workflow);
    }
    return JSON.stringify({ isDraft: false, isPrerelease: false, assets: [] });
  }, '0.4.0', 'abc', harness.options);
  const snapshots = harness.snapshots.map(({ lines }) => lines.join(' '));
  for (const name of ['Extension 检查与构建', 'Companion 应用构建', 'ZIP 打包', '上传 Release 和 ZIP 附件']) assert.ok(snapshots.some((text) => text.includes(name)));
  assert.ok(snapshots.some((text) => text.includes('已结束 3/4')));
  assert.ok(!harness.messages.join('').includes('发布成功'));
});

test('verbose 进度不覆盖日志，窄终端限制行宽并过滤远端控制字符', () => {
  const chunks = [], messages = [];
  const output = { isTTY: true, columns: 25, write: (text) => chunks.push(text) };
  liveProgress(output, (text) => messages.push(text), false).update(workflowProgress(), 0);
  assert.equal(chunks.length, 0); assert.equal(messages.length, 1);
  const previous = process.env.TERM, noColor = process.env.NO_COLOR;
  try {
    process.env.TERM = 'xterm'; delete process.env.NO_COLOR;
    liveProgress(output).update(['任务\x1b[2J\n远端\r名称很长'.repeat(10), '步骤', '状态'], 0);
    assert.equal(chunks.length, 1);
    assert.ok(!chunks[0].includes('\x1b[2J')); assert.equal(chunks[0].split('\n').length, 5);
  } finally {
    if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous;
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
  }
});

test('等待耗时在 gh 查询期间每秒刷新，退出后清理刷新计时器', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const harness = resultHarness();
  let finish, elapsed = 0;
  const promise = showResult(async (program, args) => args[0] === 'auth' ? new Promise((resolve) => { finish = resolve; }) : '[]', '0.4.0', 'abc', { ...harness.options, wait: false, now: () => elapsed });
  elapsed = 1000;
  t.mock.timers.tick(1000);
  assert.equal(harness.snapshots.length, 2);
  assert.equal(harness.snapshots[1].elapsed, 1000);
  finish('');
  await promise;
  const count = harness.snapshots.length;
  t.mock.timers.tick(5000);
  assert.equal(harness.snapshots.length, count);
});
const io = (lines) => inputLines(Readable.from(lines.map((line) => line + '\n')), silent);

test('标准格式、当前与目标版本、参考提交和测试', () => {
  const result = parseRelease(standard);
  assert.equal(result.version, '0.4.0');
  assert.equal(result.notes.length, 2);
  assert.equal(result.commit.length, 40);
  assert.match(result.tests, /224/);
});
for (const title of ['版本：v0.4.0', 'WindowStash v0.4.0', '# WindowStash v0.4.0']) {
  test(`版本格式：${title}`, () => assert.equal(parseRelease(title + '\n\n- 新增教程入口').version, '0.4.0'));
}
test('Markdown 标题与格式化无序列表', () => {
  const result = parseRelease('# WindowStash v0.4.0\n\n## 更新说明\n- **新增**教程\n- 修复关联\n\n## 测试\n- 224 项通过');
  assert.deepEqual(result.notes, ['新增教程', '修复关联']);
});
test('ChatGPT 升级描述明确区分两个版本', () => assert.equal(parseRelease('当前版本 v0.3.0 升级至 v0.4.0\n\n更新说明：\n修复关联问题').version, '0.4.0'));
test('Codex 长文本排除日志、文件与合并报告', () => {
  const result = parseRelease('## 开发总结\n- 新增教程入口\n- 优化恢复体验\n\n## 修改文件\n- scripts/test.ts\n\n## 测试\n- 224 tests passed\n```sh\ngit push origin main\n```\n## Git 合并报告\nmain HEAD：56b8e2fe30517972e54cfe9a5ba4befd822f924c\n目标版本：v0.4.0');
  assert.deepEqual(result.notes, ['新增教程入口', '优化恢复体验']);
});
test('多个可能目标不猜测', () => assert.deepEqual(parseRelease('目标版本：v0.4.0 或 v0.5.0').candidates, ['0.4.0', '0.5.0']));
test('缺少目标版本', () => assert.equal(parseRelease('当前版本：v0.3.0\n- 新增教程').version, ''));
test('缺少更新说明', () => assert.deepEqual(parseRelease('目标版本：0.4.0\n测试：\n- 224 项通过').notes, []));
test('非发布版本号及代码不被识别', () => assert.equal(parseRelease('依赖版本 19.3.0\n```sh\nWindowStash v0.4.0\n```').version, ''));
test('版本递增与格式严格校验', () => {
  for (const version of ['0.3.0', '0.2.9', '00.4.0', '0.4.0-beta', '0.4.0;touch /tmp/a']) assert.throws(() => validateInput(version, '0.3.0', ['修复']));
  assert.throws(() => validateInput('0.4.0', '0.3.0', []));
  validateInput('0.4.0', '0.3.0', ['修复']);
});
test('多行粘贴含空行，以 :end 结束且后续输入保留', async () => {
  const input = io(['WindowStash v0.4.0', '', '更新内容：', '- 修复', ':end', '1']);
  assert.match(await input.paste(''), /\n\n/);
  assert.equal(await input.ask(''), '1'); input.close();
});
test('EOF 和 :cancel 停止', async () => {
  for (const lines of [['a'], [':cancel']]) {
    const input = io(lines); await assert.rejects(input.paste(''), /取消/); input.close();
  }
});
test('缺少版本时补充版本并保留已输入的说明', async () => {
  const input = io(['更新说明：', '- 新增教程', ':end', '0.5.0']);
  const result = await editRelease(input, '0.3.0', () => {});
  assert.equal(result.version, '0.5.0'); assert.deepEqual(result.notes, ['新增教程']); input.close();
});
test('冲突版本人工选择', async () => {
  const input = io(['目标版本：0.4.0 或 0.5.0', '- 修复关联', ':end', '2', '1']);
  assert.equal((await editRelease(input, '0.3.0', () => {})).version, '0.5.0'); input.close();
});
test('发布信息输入时用户取消', async () => {
  const input = io(['WindowStash v0.4.0', '- 修复关联', ':cancel']);
  await assert.rejects(editRelease(input, '0.3.0', () => {}), /取消/); input.close();
});
test('粘贴中的命令仅为文本，不执行', async () => {
  const input = io(['版本：0.4.0', '更新说明：', '- $(touch /tmp/never-execute-release)', ':end', '1']);
  const result = await editRelease(input, '0.3.0', () => {});
  assert.match(result.notes[0], /touch/); input.close();
});

const head = 'a'.repeat(40);
function mockGit(overrides = {}) {
  const responses = {
    'branch --show-current': 'main', 'rev-parse HEAD': head, 'status --porcelain --untracked-files=all': '',
    'ls-files -u': '', 'rev-parse origin/main': head,
    'remote get-url --all origin': 'https://github.com/lishangyang290/windowstash.git',
    'remote get-url --push --all origin': 'git@github.com:lishangyang290/windowstash.git',
    'ls-remote --exit-code origin refs/heads/main': `${head}\trefs/heads/main`,
    'tag --list v0.4.0': '', 'ls-remote origin refs/tags/v0.4.0': '', ...overrides,
  };
  return async (program, args) => {
    assert.equal(program, 'git'); const key = args.join(' ');
    assert.ok(key in responses, `unexpected command ${key}`); return responses[key];
  };
}
for (const [title, overrides, pattern] of [
  ['不是 main', { 'branch --show-current': 'feat/test' }, /main/],
  ['工作区不干净', { 'status --porcelain --untracked-files=all': '?? user.txt' }, /不干净/],
  ['未解决冲突', { 'ls-files -u': 'conflict' }, /冲突/],
  ['main 与 tracking 不一致', { 'rev-parse origin/main': 'b'.repeat(40) }, /不一致/],
  ['main 与真实远端不一致', { 'ls-remote --exit-code origin refs/heads/main': 'b'.repeat(40) }, /远端不同/],
  ['本地 Tag 已存在', { 'tag --list v0.4.0': 'v0.4.0' }, /本地已有/],
  ['远端 Tag 已存在', { 'ls-remote origin refs/tags/v0.4.0': head }, /远端已有/],
  ['push 远端错误', { 'remote get-url --push --all origin': 'git@github.com:other/repo.git' }, /读写地址/],
]) test(title, async () => assert.rejects(preflight(mockGit(overrides), '0.4.0', '0.3.0', ['修复'], async () => false), pattern));
test('Release 已存在', async () => assert.rejects(preflight(mockGit(), '0.4.0', '0.3.0', ['修复'], async () => true), /已有对应 Release/));
test('只读远端检查通过', async () => assert.equal((await preflight(mockGit(), '0.4.0', '0.3.0', ['修复'], async () => false)).head, head));
test('测试失败中断检查，绝不调用提交或推送', async () => {
  const commands = [];
  await assert.rejects(runChecks(async (program, args) => { commands.push([program, ...args]); if (args.includes('test')) throw new Error('tests failed'); }, '0.4.0'), /failed/);
  assert.ok(!commands.some((cmd) => cmd.includes('push') || cmd.includes('commit')));
});

for (const platform of ['darwin', 'win32', 'linux']) test(`发布类型检查仅对 Mac Extension 隔离上级全局类型：${platform}`, async () => {
  const commands = [];
  await runChecks(async (program, args) => { commands.push([program, ...args]); }, '0.6.0', platform);
  const checks = commands.filter((cmd) => cmd.includes('typecheck'));
  assert.deepEqual(checks, [
    ['npm', 'run', 'typecheck', ...(platform === 'darwin' ? ['--', '--incremental', 'false', '--types', 'node,vite/client'] : [])],
    ['npm', '--prefix', 'companion', 'run', 'typecheck'],
  ]);
  assert.equal(commands.filter((cmd) => cmd.includes('build')).length, 2);
  await assert.rejects(runChecks(async (program, args) => {
    if (args.includes('typecheck')) throw new Error('typecheck failed');
    assert.ok(!args.includes('build'));
  }, '0.6.0', platform), /typecheck failed/);
});

async function fixture(t, sourceRoot = root) {
  const directory = await mkdtemp(resolve(tmpdir(), 'windowstash-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ['package.json', 'package-lock.json', 'companion/package.json', 'companion/package-lock.json', 'companion/src-tauri/tauri.conf.json', 'companion/src-tauri/Cargo.toml', 'companion/src-tauri/Cargo.lock', 'public/开始使用.html', 'scripts/validate-release-version.mjs']) {
    await mkdir(resolve(directory, path, '..'), { recursive: true }); await cp(resolve(sourceRoot, path), resolve(directory, path));
  }
  await mkdir(resolve(directory, '.github/release-notes'), { recursive: true });
  // Release checks run after version preparation. Fixtures must not inherit that version.
  const baseline = await planFiles(directory, '0.3.0', ['fixture baseline']);
  await applyFiles(directory, baseline.filter((file) => file.before !== null));
  return directory;
}
test('九处版本同步、依赖保持不变、旧教程包名更新、恢复', async (t) => {
  const directory = await fixture(t), run = command(directory);
  const plan = await planFiles(directory, '0.4.0', ['修复关联', '新增教程']);
  await applyFiles(directory, plan);
  assert.match(await run(process.execPath, ['scripts/validate-release-version.mjs', '0.4.0']), /通过/);
  for (const path of ['package-lock.json', 'companion/package-lock.json']) {
    const before = JSON.parse(await readFile(resolve(root, path), 'utf8'));
    const after = JSON.parse(await readFile(resolve(directory, path), 'utf8'));
    delete before.packages['']; delete after.packages['']; assert.deepEqual(after.packages, before.packages);
  }
  const guide = await readFile(resolve(directory, 'public/开始使用.html'), 'utf8');
  assert.ok(!guide.includes('WindowStash-v0.3.0'));
  assert.match(guide, /WindowStash-v0\.4\.0-macOS-arm64-setup\.pkg/);
  validateGuidePackageTrees(guide, '0.4.0');
  const lock = plan.find((f) => f.path.endsWith('Cargo.lock'));
  const undo = lock.after.split('[[package]]').map((block) => /^name = "windowstash-companion"$/m.test(block) ? block.replace('version = "0.4.0"', 'version = "0.3.0"') : block).join('[[package]]');
  assert.equal(undo, lock.before);
  await restoreFiles(directory, plan);
  for (const f of plan.filter((f) => f.before !== null)) assert.equal(await readFile(resolve(directory, f.path), 'utf8'), f.before);
  await assert.rejects(stat(resolve(directory, '.github/release-notes/v0.4.0.md')), /ENOENT/);
});
test('九处版本检查能检测不一致', async (t) => {
  const directory = await fixture(t);
  await writeFile(resolve(directory, 'package.json'), '{"version":"0.4.0"}\n', 'utf8');
  await assert.rejects(command(directory)(process.execPath, ['scripts/validate-release-version.mjs', '0.3.0']), /不一致/);
});
test('恢复不覆盖检查后出现的用户修改', async (t) => {
  const directory = await fixture(t), plan = await planFiles(directory, '0.4.0', ['修复']);
  await applyFiles(directory, plan); await writeFile(resolve(directory, 'package.json'), 'user edit', 'utf8');
  await assert.rejects(restoreFiles(directory, plan), /拒绝覆盖/);
  assert.equal(await readFile(resolve(directory, 'package.json'), 'utf8'), 'user edit');
});
test('不覆盖既有 Notes', async (t) => {
  const directory = await fixture(t); await writeFile(resolve(directory, '.github/release-notes/v0.4.0.md'), 'existing', 'utf8');
  await assert.rejects(planFiles(directory, '0.4.0', ['修复']), /不会覆盖/);
});
test('严格 dry-run 成功，无文件、Commit、Tag、推送或构建副作用', async (t) => {
  const directory = await fixture(t), run = command(directory);
  for (const path of ['release.mjs', 'release-core.mjs', 'release-ui.mjs']) await cp(resolve(root, 'scripts', path), resolve(directory, 'scripts', path));
  await symlink(resolve(root, 'node_modules'), resolve(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(resolve(directory, '.gitignore'), 'node_modules\n', 'utf8');
  await run('git', ['init', '-b', 'main']);
  await run('git', ['config', 'user.email', 'test@example.com']); await run('git', ['config', 'user.name', 'Release Test']);
  await run('git', ['add', '.']); await run('git', ['commit', '-m', 'fixture']);
  const hash = await run('git', ['rev-parse', 'HEAD']);
  await run('git', ['update-ref', 'refs/remotes/origin/main', hash]);
  await run('git', ['remote', 'add', 'origin', 'https://github.com/lishangyang290/windowstash.git']);
  await writeFile(resolve(directory, '.git/info/exclude'), 'fetch-mock.mjs\n', 'utf8');
  await processMock(directory, hash);
  // Only the temporary repository uses a Git wrapper and HTTP mock. No production remote is touched.
  const { spawn } = await import('node:child_process');
  const preview = async (verbose = false, versionOnly = false) => new Promise((done, fail) => {
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(directory, 'fetch-mock.mjs')).href, 'scripts/release.mjs', '--dry-run', ...(verbose ? ['--verbose'] : [])], { cwd: directory, env: childEnv });
    let text = ''; child.stdout.on('data', (data) => { text += data; }); child.stderr.on('data', (data) => { text += data; }); child.on('error', fail); child.on('close', (code) => code === 0 ? done(text) : fail(new Error(text)));
    child.stdin.end(versionOnly ? '0.4.0\n- 新增教程入口\n:end\n' : standard + '\n:end\n');
  });
  const output = await preview();
  assert.match(output, /预演通过/);
  assert.doesNotMatch(output, /恢复失败的发布|检测到上次发布未完成|请补充本次更新说明|请选择/);
  assert.match(await preview(false, true), /请补充本次更新说明[\s\S]*预演通过/);
  assert.doesNotMatch(output, /检查 \/ 执行：/);
  assert.ok(!output.includes('\x1b['));
  assert.match(await preview(true), /检查 \/ 执行：git/);
  assert.equal(await run('git', ['status', '--porcelain']), '');
  assert.equal(await run('git', ['rev-parse', 'HEAD']), hash);
  assert.equal(await run('git', ['tag']), '');
  await assert.rejects(stat(resolve(directory, '.windowstash-release.json')), /ENOENT/);
});
for (const failStep of ['commit', 'main', 'tagPush', 'none']) test(`发布步骤顺序及失败状态：${failStep}`, async () => {
  const calls = [];
  const run = async (program, args) => {
    calls.push(args); assert.equal(program, 'git');
    if ((failStep === 'commit' && args[0] === 'commit') || (failStep === 'main' && args[0] === 'push' && args.at(-1).endsWith(':refs/heads/main')) || (failStep === 'tagPush' && args[0] === 'push' && args.at(-1).startsWith('refs/tags'))) throw new Error('push failure');
    if (args[0] === 'diff' || args[0] === 'diff-tree') return 'package.json';
    if (args[0] === 'rev-parse') return head;
    if (args[0] === 'branch') return 'main';
    return '';
  };
  if (failStep === 'none') { assert.equal((await publish(run, [{ path: 'package.json' }], '0.4.0')).tagPush, true); }
  else await assert.rejects(publish(run, [{ path: 'package.json' }], '0.4.0'), (error) => {
    assert.equal(error.progress.main, failStep === 'tagPush');
    assert.equal(error.progress.tag, failStep === 'tagPush'); return true;
  });
  assert.equal(calls.filter((args) => args[0] === 'commit').length, 1);
  assert.ok(!calls.some((args) => args.includes('--force')));
  if (failStep === 'main') assert.ok(!calls.some((args) => args[0] === 'tag'));
});
test('结果不会把进行中的构建误报成功', async () => {
  const messages = [], original = console.log;
  console.log = (text) => messages.push(text);
  try {
    await showResult(async (program, args) => {
      if (args[0] === 'auth') return '';
      const workflow = { databaseId: 123, headSha: head, headBranch: 'v0.4.0', status: 'in_progress', url: 'https://example.test' };
      return JSON.stringify(args[1] === 'list' ? [workflow] : workflow);
    }, '0.4.0', head);
    assert.ok(messages.some((text) => text.includes('构建中')));
    assert.ok(!messages.some((text) => text.includes('发布成功')));
  } finally { console.log = original; }
});
test('同一行的当前和目标版本按上下文识别', () => assert.equal(parseRelease('当前版本：v0.3.0，目标版本：v0.4.0').version, '0.4.0'));
test('启动文件权限被 Git 记录为 100755', async () => {
  // Read the real index mode, which remains meaningful even on Windows filesystems.
  assert.match(await command(root)('git', ['ls-files', '--stage', '--', 'WindowStash Release.command']), /^100755 /);
});

for (const scenario of ['cancel', 'testFailure', 'mainPushFailure', 'tagPushFailure', 'tagCreationFailure', 'commitFailure', 'journalRace']) {
  test(`完整交互生命周期（临时仓库）：${scenario}`, async (t) => {
    const directory = await fixture(t), run = command(directory);
    for (const path of ['release.mjs', 'release-core.mjs', 'release-ui.mjs']) await cp(resolve(root, 'scripts', path), resolve(directory, 'scripts', path));
    await writeFile(resolve(directory, 'scripts/release-tests.mjs'), "import { test } from 'node:test'; test('fixture check', () => {});\n", 'utf8');
    await symlink(resolve(root, 'node_modules'), resolve(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(resolve(directory, 'companion/node_modules'));
    await writeFile(resolve(directory, '.gitignore'), 'node_modules\n.windowstash-release.json\n.windowstash-release.json.*.tmp\nmock-bin\nfetch-mock.mjs\npush.log\n.status-count\n', 'utf8');
    await run('git', ['init', '-b', 'main']);
    await run('git', ['config', 'user.email', 'test@example.com']); await run('git', ['config', 'user.name', 'Release Test']);
    await run('git', ['add', '.']); await run('git', ['commit', '-m', 'fixture']);
    const hash = await run('git', ['rev-parse', 'HEAD']);
    await run('git', ['update-ref', 'refs/remotes/origin/main', hash]);
    await run('git', ['remote', 'add', 'origin', 'https://github.com/lishangyang290/windowstash.git']);
    await processMock(directory, hash, scenario);
    const { spawn } = await import('node:child_process');
    const result = await new Promise((done, fail) => {
      const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(directory, 'fetch-mock.mjs')).href, 'scripts/release.mjs'], { cwd: directory, env: childEnv });
      let text = ''; child.stdout.on('data', (data) => { text += data; }); child.stderr.on('data', (data) => { text += data; }); child.on('error', fail); child.on('close', (code) => done({ code, text }));
      child.stdin.end(standard + '\n:end\n' + (scenario === 'cancel' ? '取消' : '发布 v0.4.0') + '\n');
    });
    assert.equal(result.code, 1, result.text);
    if (['cancel', 'testFailure'].includes(scenario)) {
      assert.match(result.text, /改动已恢复/);
      assert.equal(await run('git', ['status', '--porcelain']), '');
      assert.equal(await run('git', ['rev-parse', 'HEAD']), hash);
      await assert.rejects(stat(resolve(directory, 'push.log')), /ENOENT/);
      await assert.rejects(stat(resolve(directory, '.windowstash-release.json')), /ENOENT/);
    } else if (scenario === 'journalRace') {
      assert.equal(await run('git', ['rev-parse', 'HEAD']), hash);
      assert.deepEqual(JSON.parse(await readFile(resolve(directory, '.windowstash-release.json'), 'utf8')), { owner: 'other' });
      assert.equal(await run('git', ['status', '--porcelain']), '');
      await assert.rejects(stat(resolve(directory, 'push.log')), /ENOENT/);
    } else {
      assert.equal(await run('git', ['rev-list', '--count', 'HEAD']), scenario === 'commitFailure' ? '1' : '2');
      const journal = JSON.parse(await readFile(resolve(directory, '.windowstash-release.json'), 'utf8'));
      assert.equal(Boolean(journal.progress.main), ['tagPushFailure', 'tagCreationFailure'].includes(scenario), result.text);
      assert.equal(await run('git', ['tag']), scenario === 'tagPushFailure' ? 'v0.4.0' : '');
      assert.match(result.text, /不要重新创建发布提交/);
      const saved = await readFile(resolve(directory, '.windowstash-release.json'), 'utf8');
      await assert.rejects(run(process.execPath, ['scripts/release.mjs']), /存在未完成发布记录/);
      await assert.rejects(run(process.execPath, ['scripts/release.mjs', '--restore']), scenario === 'commitFailure' ? /暂存区不为空/ : /已产生提交/);
      assert.equal(await readFile(resolve(directory, '.windowstash-release.json'), 'utf8'), saved);
      if (scenario === 'commitFailure') {
        await run('git', ['restore', '--staged', '--', ...journal.files.map((file) => file.path)]);
        await run(process.execPath, ['scripts/release.mjs', '--restore']);
        assert.equal(await run('git', ['status', '--porcelain']), '');
      }
    }
  });
}
test('text 围栏中的标准发布信息', () => {
  const result = parseRelease('```text\n' + standard + '\n```');
  assert.equal(result.version, '0.4.0'); assert.equal(result.notes.length, 2);
});
test('未识别字段可由用户补充', async () => {
  const input = io(['无法识别的摘要', ':end', '0.4.0']);
  const result = await editRelease(input, '0.3.0', () => {});
  assert.equal(result.version, '0.4.0'); assert.deepEqual(result.notes, []); input.close();
});
test('子进程 UTF-8 输出跨 Buffer 边界仍完整', async () => {
  const output = await command(root)(process.execPath, ['-e', "const b=Buffer.from('中文更新说明'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),10);"]);
  assert.equal(output, '中文更新说明');
});
for (const scenario of ['missingGh', 'failed', 'success', 'missingAsset', 'draft']) {
  test(`发布结果状态：${scenario}`, async () => {
    const messages = [], original = console.log;
    console.log = (text) => messages.push(text);
    try {
      await showResult(async (program, args) => {
        if (scenario === 'missingGh') throw new Error('missing gh');
        if (args[0] === 'auth') return '';
        if (args[0] === 'run') {
          const workflow = { databaseId: 123, headSha: head, headBranch: 'v0.4.0', status: 'completed', conclusion: scenario === 'failed' ? 'failure' : 'success', url: 'https://example.test', jobs: [] };
          return JSON.stringify(args[1] === 'list' ? [workflow] : workflow);
        }
        return JSON.stringify({ isDraft: scenario === 'draft', isPrerelease: false, url: 'https://example.test/release', assets: scenario === 'missingAsset' ? [] : releaseAssets() });
      }, '0.4.0', head);
      assert.equal(messages.some((text) => text.includes('发布成功')), scenario === 'success');
      if (scenario === 'missingGh') assert.ok(messages.some((text) => text.includes('无法自动确认')));
      if (scenario === 'failed') assert.ok(messages.some((text) => text.includes('构建未成功')));
    } finally { console.log = original; }
  });
}
test('UI 使用留白、轻分隔线与明确的粘贴结束提示', () => {
  const messages = [], ui = terminalUI({ isTTY: false }, (text) => messages.push(text));
  ui.section('识别结果');
  assert.match(messages[0], /^\n─+\n\n识别结果\n$/);
  assert.match(ui.paste('粘贴内容'), /:end.*\n.*:cancel/);
  assert.match(ui.prompt('请选择'), /\n\n {2}› $/);
});
test('状态颜色克制，普通字段保持默认颜色', (t) => {
  const previous = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.TERM = 'xterm-256color'; delete process.env.NO_COLOR;
  const messages = [], ui = terminalUI({ isTTY: true }, (text) => messages.push(text));
  ui.success('完成'); ui.warning('等待'); ui.error('失败'); ui.field('仓库', 'windowstash');
  assert.ok(messages[0].includes('\x1b[32m')); assert.ok(messages[1].includes('\x1b[33m')); assert.ok(messages[2].includes('\x1b[31m'));
  assert.ok(!messages[3].includes('\x1b['));
});
test('非 TTY、NO_COLOR、TERM=dumb 均输出纯文本', (t) => {
  const previous = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  for (const [tty, term, noColor] of [[false, 'xterm', false], [true, 'xterm', true], [true, 'dumb', false]]) {
    process.env.TERM = term;
    if (noColor) process.env.NO_COLOR = ''; else delete process.env.NO_COLOR;
    const messages = [], ui = terminalUI({ isTTY: tty }, (text) => messages.push(text));
    ui.section('标题'); ui.success('完成'); ui.warning('等待'); ui.error('失败'); ui.hint('提示');
    assert.ok(!(messages.join('\n') + ui.prompt('选择') + ui.paste('粘贴')).includes('\x1b['));
  }
});
for (const verbose of [false, true]) test(`命令呈现保留参数和返回值，verbose=${verbose}`, async () => {
  const messages = [], ui = terminalUI({ isTTY: false }, (text) => messages.push(text));
  const calls = [], execute = presentedCommand(async (...args) => { calls.push(args); return 'original output'; }, ui, verbose);
  const args = ['--prefix', 'companion', 'run', 'test'];
  assert.equal(await execute('npm', args, true), 'original output');
  assert.deepEqual(calls, [['npm', args, verbose, undefined]]);
  assert.match(messages.join('\n'), /进行中.*Companion · test[\s\S]*通过.*Companion · test/);
  assert.equal(messages.some((text) => text.includes('检查 / 执行：')), verbose);
});
test('命令失败显示失败状态并保留原错误，禁止误报成功', async () => {
  const messages = [], ui = terminalUI({ isTTY: false }, (text) => messages.push(text)), failure = new Error('original failure');
  const execute = presentedCommand(async () => { throw failure; }, ui);
  await assert.rejects(execute('npm', ['run', 'build'], true), (error) => error === failure);
  assert.match(messages.join('\n'), /失败.*Extension · build未通过/);
  assert.ok(!messages.some((text) => /^ {2}通过/.test(text)));
});
test('安静模式中只读 Git 命令没有冗余日志', async () => {
  const messages = [], execute = presentedCommand(async () => 'main', terminalUI({ isTTY: false }, (text) => messages.push(text)));
  assert.equal(await execute('git', ['branch', '--show-current']), 'main'); assert.deepEqual(messages, []);
});

const reportedNotes = [
  '优化 Chrome 重启后的工作区关联，减少识别失败和重复打开窗口的问题。',
  '提高休眠标签页的恢复稳定性，支持手动将当前窗口关联到已有工作区。',
  '新增使用教程入口，优化教程阅读和代码复制体验。',
];
for (const marker of ['-', '*', '•']) test(`回归：${marker} 列表完整保留用户报告的三条说明`, () => {
  const result = parseRelease(`WindowStash v0.4.0\n\n更新内容：\n\n${reportedNotes.map((note) => `${marker} ${note}`).join('\n')}`);
  assert.equal(result.version, '0.4.0');
  assert.deepEqual(result.notes, reportedNotes);
});
test('回归：混合列表符号保留顺序、标点和完整文案', () => {
  const result = parseRelease(`WindowStash v0.4.0\n\n更新内容：\n- ${reportedNotes[0]}\n* ${reportedNotes[1]}\n• ${reportedNotes[2]}`);
  assert.deepEqual(result.notes, reportedNotes);
});
test('回归：正文中的工作区、文件、测试、构建和仓库不被当作元数据', () => {
  const notes = ['优化工作区关联。', '修复配置文件读取问题。', '新增测试覆盖，提升构建稳定性。', '支持从仓库导入模板。'];
  assert.deepEqual(parseRelease(`版本：v0.4.0\n\n更新说明：\n${notes.map((note) => `- ${note}`).join('\n')}`).notes, notes);
});
test('回归：更新说明之后的真实测试日志、文件路径和提交报告仍被排除', () => {
  const result = parseRelease(`WindowStash v0.4.0\n\n更新内容：\n${reportedNotes.map((note) => `- ${note}`).join('\n')}\n- 224 tests passed\n- scripts/test.ts\n\n测试：\n- 224 项通过\n\nmain HEAD：\n${head}`);
  assert.deepEqual(result.notes, reportedNotes);
});
test('回归：连续列表项不会被覆盖或去重', () => {
  const notes = ['优化工作区关联。', '优化工作区关联。', '新增教程入口。'];
  assert.deepEqual(parseRelease(`WindowStash v0.4.0\n\n更新说明：\n${notes.map((note) => `- ${note}`).join('\n')}`).notes, notes);
});
test('回归：多行粘贴保留完整说明且无需识别确认', async () => {
  const input = io(['WindowStash v0.5.0', '', '更新内容：', ...reportedNotes.map((note) => `• ${note}`), ':end']);
  const result = await editRelease(input, '0.3.0', () => {});
  assert.equal(result.version, '0.5.0'); assert.deepEqual(result.notes, reportedNotes); input.close();
});

test('验收：说明中的版本引用不覆盖目标版本，普通段落不丢失', () => {
  const result = parseRelease('WindowStash v0.4.0\n\n更新说明：\n- 修复从 v0.1.0 升级至 v0.2.0 时的恢复问题。\n- 优化版本：v0.3.0 的兼容体验。\n\n优化版本显示和更新说明阅读体验。');
  assert.equal(result.version, '0.4.0');
  assert.deepEqual(result.notes, ['修复从 v0.1.0 升级至 v0.2.0 时的恢复问题。', '优化版本：v0.3.0 的兼容体验。', '优化版本显示和更新说明阅读体验。']);
});
test('验收：纯段落中的升级引用不误识别成目标', () => {
  const result = parseRelease('目标版本：0.4.0\n\n更新说明：\n修复从 v0.1.0 升级至 v0.2.0 后的数据读取问题。');
  assert.equal(result.version, '0.4.0'); assert.equal(result.notes.length, 1);
});
test('验收：输入完整说明支持 • 列表符号', async () => {
  const input = io(['WindowStash v0.4.0', '更新说明：', '• 优化关联', '• 提高稳定性', ':end']);
  assert.deepEqual((await editRelease(input, '0.3.0', () => {})).notes, ['优化关联', '提高稳定性']); input.close();
});
test('验收：恢复记录原子创建、原子更新、权限与失败保留', async (t) => {
  const directory = await fixture(t), path = resolve(directory, '.windowstash-release.json');
  const journal = { head, version: '0.4.0', files: await planFiles(directory, '0.4.0', ['修复']), progress: {} };
  await saveJournal(path, journal, true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), journal);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(saveJournal(path, { other: true }, true), /EEXIST/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), journal);
  journal.progress = { commit: head, main: true, tag: false, tagPush: false };
  await saveJournal(path, journal);
  const saved = await readFile(path, 'utf8');
  const invalid = {}; invalid.self = invalid;
  await assert.rejects(saveJournal(path, invalid), /circular/i);
  assert.equal(await readFile(path, 'utf8'), saved);
  assert.deepEqual(JSON.parse(saved).progress, journal.progress);
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.tmp')));
});
test('验收：原子更新期间记录始终是完整 JSON', async (t) => {
  const directory = await fixture(t), path = resolve(directory, '.windowstash-release.json');
  await saveJournal(path, { step: 0 }, true);
  for (let step = 1; step <= 5; step++) {
    const saving = saveJournal(path, { step, text: '完整记录'.repeat(1000) });
    JSON.parse(await readFile(path, 'utf8'));
    await saving;
    assert.equal(JSON.parse(await readFile(path, 'utf8')).step, step);
  }
});
for (const [title, overrides, pattern] of [
  ['HEAD 已改变', { 'rev-parse HEAD': 'b'.repeat(40) }, /HEAD 改变/],
  ['分支已改变', { 'branch --show-current': 'feat/other' }, /分支已改变/],
  ['暂存区被修改', { 'diff --cached --name-only': 'user.txt' }, /暂存区不为空/],
]) test(`验收：自动恢复拒绝${title}`, async (t) => {
  const directory = await fixture(t), files = await planFiles(directory, '0.4.0', ['修复']);
  await applyFiles(directory, files);
  await assert.rejects(recoverPrepared(mockGit({ 'diff --cached --name-only': '', ...overrides }), directory, { head, version: '0.4.0', files, progress: {} }), pattern);
  assert.match(await readFile(resolve(directory, 'package.json'), 'utf8'), /"version": "0.4.0"/);
});
test('验收：活跃发布进程不能被其他会话恢复，所属会话可安全恢复', async (t) => {
  const directory = await fixture(t), files = await planFiles(directory, '0.4.0', ['修复']);
  await applyFiles(directory, files);
  const journal = { head, version: '0.4.0', files, progress: {}, pid: process.pid };
  const run = mockGit({ 'diff --cached --name-only': '' });
  await assert.rejects(recoverPrepared(run, directory, journal), /仍在运行/);
  await recoverPrepared(run, directory, journal, true);
  assert.equal(await readFile(resolve(directory, 'package.json'), 'utf8'), files[0].before);
});
test('验收：恢复记录拒绝越界文件和重复路径', async (t) => {
  const directory = await fixture(t), files = await planFiles(directory, '0.4.0', ['修复']);
  const journal = { head, version: '0.4.0', files, progress: {} };
  await assert.rejects(recoverPrepared(mockGit(), directory, { ...journal, files: [{ path: '../user.txt', before: 'old', after: 'new' }] }), /文件范围无效/);
  await assert.rejects(recoverPrepared(mockGit(), directory, { ...journal, files: [files[0], files[0]] }), /文件范围无效/);
  await assert.rejects(planFiles(directory, '../unsafe', ['修复']), /X.Y.Z/);
});
test('验收：版本准备不覆盖外部修改或突然出现的 Notes', async (t) => {
  const directory = await fixture(t), files = await planFiles(directory, '0.4.0', ['修复']);
  await writeFile(resolve(directory, 'package.json'), 'user edit', 'utf8');
  await assert.rejects(applyFiles(directory, files), /拒绝覆盖/);
  assert.equal(await readFile(resolve(directory, 'package.json'), 'utf8'), 'user edit');
  const note = files.at(-1);
  await writeFile(resolve(directory, note.path), 'other notes', 'utf8');
  await assert.rejects(applyFiles(directory, [note]), /EEXIST/);
  assert.equal(await readFile(resolve(directory, note.path), 'utf8'), 'other notes');
});
test('验收：发布推送显式关闭自动附带其他 Tag', async () => {
  const pushes = [];
  await publish(async (program, args) => {
    if (args[0] === 'push') pushes.push(args);
    if (args[0] === 'diff' || args[0] === 'diff-tree') return 'package.json';
    if (args[0] === 'rev-parse') return head;
    if (args[0] === 'branch') return 'main';
    return '';
  }, [{ path: 'package.json' }], '0.4.0');
  assert.deepEqual(pushes, [['push', '--no-follow-tags', 'origin', `${head}:refs/heads/main`], ['push', '--no-follow-tags', 'origin', 'refs/tags/v0.4.0:refs/tags/v0.4.0']]);
});
test('验收：正式版本已准备为新版本时，测试夹具仍独立且可再次验证发布', async (t) => {
  const prepared = await fixture(t);
  await applyFiles(prepared, await planFiles(prepared, '0.4.0', ['准备发布']));
  const directory = await fixture(t, prepared);
  assert.match(await command(directory)(process.execPath, ['scripts/validate-release-version.mjs', '0.3.0']), /通过/);
  const plan = await planFiles(directory, '0.4.0', ['验证']);
  assert.equal(plan.length, 9);
  await applyFiles(directory, plan);
  assert.match(await command(directory)(process.execPath, ['scripts/validate-release-version.mjs', '0.4.0']), /通过/);
});

const recoverySha = '02403909ebff32c58269c506aa0aa05b7c3a36c5';
const recoveryId = 39209631988;
const recoveryWorkflow = (overrides = {}) => ({ id: recoveryId, event: 'push', path: '.github/workflows/release.yml',
  head_sha: recoverySha, head_branch: 'v0.6.0', run_attempt: 1, status: 'completed', conclusion: 'cancelled',
  html_url: `https://github.com/lishangyang290/windowstash/actions/runs/${recoveryId}`, ...overrides });
const recoveryJobs = (conclusion = 'success') => ['Windows x64', 'macOS arm64', 'Publish complete Release'].map((name) => ({
  name, status: 'completed', conclusion, steps: [{ name: 'Validate Extension', status: 'completed', conclusion }],
}));

function recoveryMock(scenario = '') {
  const calls = [];
  let releaseChecks = 0, workflowChecks = 0;
  const run = async (program, args) => {
    calls.push([program, ...args]);
    if (program === 'git') {
      const responses = {
        'branch --show-current': scenario === 'branch' ? 'other' : 'main', 'rev-parse HEAD': 'b'.repeat(40),
        'status --porcelain --untracked-files=all': scenario === 'dirty' ? ' M user.txt' : '',
        'remote get-url --all origin': 'https://github.com/lishangyang290/windowstash.git',
        'remote get-url --push --all origin': 'https://github.com/lishangyang290/windowstash.git',
        'ls-remote --exit-code origin refs/heads/main': `${(scenario === 'main' ? 'c' : 'b').repeat(40)}\trefs/heads/main`,
        'ls-remote origin refs/tags/v0.6.0': `${recoverySha}\trefs/tags/v0.6.0`,
        'tag --list v0.6.0': 'v0.6.0',
        'rev-parse refs/tags/v0.6.0': scenario === 'localTag' ? 'c'.repeat(40) : recoverySha,
        [`merge-base --is-ancestor ${recoverySha} ${'b'.repeat(40)}`]: '',
        [`show ${recoverySha}:package.json`]: JSON.stringify({ version: scenario === 'version' ? '0.5.0' : '0.6.0' }),
        [`show ${recoverySha}:.github/release-notes/v0.6.0.md`]: scenario === 'notes' ? '' : '- fixture notes',
      };
      if (scenario === 'ancestry' && args[0] === 'merge-base') throw new Error('Tag is not an ancestor');
      assert.ok(args.join(' ') in responses, `禁止未模拟的 Git 操作：${args}`);
      return responses[args.join(' ')];
    }
    assert.equal(program, 'gh');
    if (args[0] === 'auth') {
      if (scenario === 'auth') throw new Error('gh not authenticated');
      if (scenario === 'missing') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      return '';
    }
    if (args[0] === 'run') {
      assert.deepEqual(args, ['run', 'rerun', String(recoveryId), '--repo', 'lishangyang290/windowstash']);
      if (scenario === 'requestFailure') throw new Error('fixture rerun response lost');
      return '';
    }
    assert.equal(args[0], 'api');
    const path = args[1].replace('repos/lishangyang290/windowstash/', '');
    let value;
    if (path === 'git/ref/tags/v0.6.0') value = { ref: 'refs/tags/v0.6.0', object: { type: 'commit', sha: scenario === 'remoteTag' ? 'c'.repeat(40) : recoverySha } };
    else if (path.startsWith('releases?')) value = scenario === 'published' ? [{ tag_name: 'v0.6.0', draft: false, prerelease: false, html_url: 'https://example.test/release', assets: ['Windows-x64.zip', 'macOS-arm64.zip'].map(suffix => ({ name: `WindowStash-v0.6.0-${suffix}`, size: 100 })) }]
      : scenario === 'release' || (scenario === 'changed' && ++releaseChecks > 1) ? [{ tag_name: 'v0.6.0', draft: true }] : [];
    else if (path.includes('event=push')) value = { workflow_runs: [recoveryWorkflow()] };
    else if (path === `actions/runs/${recoveryId}`) value = recoveryWorkflow({
      ...(scenario === 'attemptChanged' ? { run_attempt: ++workflowChecks } : {}),
      ...(scenario === 'sha' ? { head_sha: 'c'.repeat(40) } : {}),
      ...(scenario === 'tag' ? { head_branch: 'v0.5.0' } : {}),
      ...(scenario === 'event' ? { event: 'workflow_dispatch' } : {}),
      ...(scenario === 'running' ? { status: 'in_progress', conclusion: null } : {}),
      ...(scenario === 'queued' ? { status: 'queued', conclusion: null } : {}),
      ...(scenario === 'success' ? { conclusion: 'success' } : {}),
      ...(scenario === 'failure' ? { conclusion: 'failure' } : {}),
    });
    else if (path.includes('event=workflow_dispatch')) value = { workflow_runs: scenario === 'unverified' ? [] : [{ id: 39201839468, event: 'workflow_dispatch', head_sha: recoverySha, run_attempt: 1, status: 'completed', conclusion: 'success' }] };
    else if (path === 'actions/runs/39201839468/attempts/1/jobs?per_page=100') value = { jobs: recoveryJobs().slice(0, scenario === 'onePlatform' ? 1 : 2) };
    else assert.fail(`未模拟的 API：${path}`);
    return JSON.stringify(value);
  };
  return { run, calls, writes: () => calls.filter(([program, subcommand]) => program === 'gh' && subcommand === 'run') };
}

test('同一入口直接输入完整发布信息，不展示启动或识别确认菜单', async () => {
  const messages = [], input = io([...standard.split('\n'), ':end', 'sentinel']);
  assert.equal((await editRelease(input, '0.3.0', line => messages.push(line))).version, '0.4.0');
  assert.equal(await input.ask(''), 'sentinel'); input.close();
  assert.doesNotMatch(messages.join('\n'), /发布新版本|恢复失败的发布|确认识别结果|请选择/);
});

test('识别 v0.6.0 原取消 Workflow，允许已验证 Tag 落后于 main', async () => {
  const mock = recoveryMock(), plan = await recoveryPlan(mock.run, '0.6.0');
  assert.equal(plan.workflowId, recoveryId); assert.equal(plan.sha, recoverySha); assert.equal(plan.attempt, 1);
  assert.equal(plan.conclusion, 'cancelled'); assert.notEqual(plan.head, plan.sha);
  assert.equal(mock.writes().length, 0);
  assert.equal((await recoveryPlan(recoveryMock('failure').run, '0.6.0')).conclusion, 'failure');
});

for (const scenario of ['dirty', 'branch', 'main', 'ancestry', 'localTag', 'remoteTag', 'sha', 'tag', 'version', 'notes', 'event', 'running', 'success', 'release', 'unverified', 'onePlatform', 'auth', 'missing']) test(`恢复条件不符安全停止：${scenario}`, async () => {
  const mock = recoveryMock(scenario);
  await assert.rejects(recoveryPlan(mock.run, '0.6.0'));
  assert.equal(mock.writes().length, 0);
});

for (const scenario of ['confirm', 'cancel', 'changed', 'attemptChanged', 'requestFailure']) test(`恢复确认只允许一次全部 Jobs 重跑：${scenario}`, async () => {
  const mock = recoveryMock(scenario), harness = resultHarness();
  let tracked = 0;
  const input = { ask: async (prompt) => scenario === 'cancel' ? '2' : prompt.includes('请输入完整') ? '发布 v0.6.0' : '1' };
  const options = { ui: harness.options.ui, track: async (run, version, sha, options) => {
    tracked++; assert.equal(sha, recoverySha); assert.equal(version, '0.6.0');
    assert.equal(options.workflowId, recoveryId); assert.equal(options.attempt, 2);
  } };
  if (scenario === 'confirm') await recoverRelease(mock.run, input, '0.6.0', options);
  else await assert.rejects(recoverRelease(mock.run, input, '0.6.0', options), scenario === 'requestFailure' ? /禁止盲目重试/ : scenario === 'changed' ? /已有对应 Release/ : scenario === 'attemptChanged' ? /恢复条件发生变化/ : /取消/);
  assert.equal(mock.writes().length, ['confirm', 'requestFailure'].includes(scenario) ? 1 : 0);
  assert.equal(tracked, scenario === 'confirm' ? 1 : 0);
});

for (const scenario of ['success', 'failure', 'retry', 'timeout', 'newAttemptTimeout', 'foreignAttempt', 'wrongSha', 'publishSkipped', 'extraAsset']) test(`恢复进度严格跟踪新 attempt：${scenario}`, async () => {
  const harness = resultHarness(), calls = [];
  let queries = 0;
  await showResult(async (program, args) => {
    assert.equal(program, 'gh'); calls.push(args);
    if (args[0] === 'auth') return '';
    if (args[0] === 'release') return JSON.stringify({ isDraft: false, isPrerelease: false, assets: [
      ...['Windows-x64.zip', 'macOS-arm64.zip'].map(suffix => ({ name: `WindowStash-v0.6.0-${suffix}`, size: 100 })),
      ...(scenario === 'extraAsset' ? [{ name: 'unexpected.exe', size: 100 }] : []),
    ] });
    assert.equal(args[0], 'api');
    const path = args[1];
    if (path.endsWith(`actions/runs/${recoveryId}`)) {
      queries++;
      if (scenario === 'retry' && queries === 3) throw new Error('ECONNRESET fixture');
      if (scenario === 'timeout' && queries > 1) throw new Error('ETIMEDOUT fixture');
      if (queries === 1 || scenario === 'newAttemptTimeout') return JSON.stringify(recoveryWorkflow());
      return JSON.stringify(recoveryWorkflow({ run_attempt: scenario === 'foreignAttempt' ? 3 : 2,
        head_sha: scenario === 'wrongSha' ? 'c'.repeat(40) : recoverySha,
        status: queries < 4 ? 'in_progress' : 'completed', conclusion: queries < 4 ? null : scenario === 'failure' ? 'failure' : 'success' }));
    }
    if (path.includes('/jobs?')) {
      assert.ok(path.includes(`/runs/${recoveryId}/attempts/2/jobs?`));
      const jobs = recoveryJobs(scenario === 'failure' ? 'failure' : 'success');
      if (scenario === 'publishSkipped') jobs[2].conclusion = 'skipped';
      return JSON.stringify({ jobs });
    }
    if (path.endsWith('/git/ref/tags/v0.6.0')) return JSON.stringify({ object: { type: 'commit', sha: recoverySha } });
    assert.fail(`未模拟的查询：${args}`);
  }, '0.6.0', recoverySha, { ...harness.options, verbose: true, workflowId: recoveryId, attempt: 2, timeout: 60000 });
  const text = harness.messages.join('\n');
  assert.equal(text.includes('发布成功'), ['success', 'retry'].includes(scenario));
  assert.ok(harness.snapshots.some(({ lines }) => lines[0].includes('等待新的 attempt 2')));
  assert.ok(!text.includes('构建未成功：cancelled'));
  assert.ok(calls.every(args => !['rerun', 'create', 'upload', 'edit', 'list'].includes(args[1])));
  if (scenario === 'failure') assert.match(text, /构建未成功：failure/);
  if (scenario === 'retry') assert.match(text, /查询诊断.*ECONNRESET/);
  if (scenario.includes('Timeout') || scenario === 'timeout') assert.match(text, /等待超时/);
  if (scenario === 'foreignAttempt' || scenario === 'wrongSha') assert.match(text, /与恢复目标不匹配/);
});

test('恢复跟踪可匿名读取新 attempt，认证回退不发送任何重跑请求', async () => {
  const harness = resultHarness(), urls = [];
  await showResult(async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, '0.6.0', recoverySha, {
    ...harness.options, workflowId: recoveryId, attempt: 2, fetch: async (url, options) => {
      urls.push(url); assert.equal(options.headers.Authorization, undefined); assert.equal(options.method, undefined);
      const value = url.includes('/jobs?') ? { jobs: recoveryJobs() }
        : url.includes('/git/ref/') ? { object: { type: 'commit', sha: recoverySha } }
          : url.includes('/releases/') ? { draft: false, prerelease: false, assets: ['Windows-x64.zip', 'macOS-arm64.zip'].map(suffix => ({ name: `WindowStash-v0.6.0-${suffix}`, size: 100 })) }
            : recoveryWorkflow({ run_attempt: 2, conclusion: 'success' });
      return { ok: true, json: async () => value };
    },
  });
  assert.ok(urls.some(url => url.includes(`/runs/${recoveryId}/attempts/2/jobs?`)));
  assert.ok(harness.messages.some(line => line.includes('发布成功')));
});

for (const value of ['0.6.0', 'v0.6.0']) test(`单独版本号按 Enter 提交，无需 :end：${value}`, async () => {
  const input = io([value, 'sentinel']);
  const result = await editRelease(input, '0.6.0', () => {});
  assert.equal(result.version, '0.6.0'); assert.deepEqual(result.notes, []);
  assert.equal(await input.ask(''), 'sentinel'); input.close();
});

for (const lines of [['00.6.0'], [':end', 'invalid'], ['无法识别', ':end', ':cancel'], ['目标版本：0.7.0']]) test(`异常版本输入安全停止：${JSON.stringify(lines)}`, async () => {
  const input = io(lines);
  await assert.rejects(editRelease(input, '0.6.0', () => {})); input.close();
});

test('全新版本自动进入原有安全检查，不询问发布模式', async () => {
  const input = io(['0.4.0']);
  const parsed = await editRelease(input, '0.3.0', () => {}); input.close();
  const state = await inspectRelease(mockGit(), parsed.version, '0.3.0', async () => false);
  assert.equal(state.kind, 'new'); assert.equal(state.state.head, head);
  const harness = resultHarness();
  assert.equal(await handleReleaseState(async () => assert.fail('禁止执行命令'), { ask: async () => assert.fail('无需额外确认') }, parsed.version, state, { ui: harness.options.ui }), false);
  assert.deepEqual(harness.messages, []);
});

for (const [scenario, kind] of [['', 'recover'], ['failure', 'recover'], ['running', 'running'], ['queued', 'running'], ['published', 'published']]) test(`目标等于当前版本时自动识别状态：${scenario || 'cancelled'}`, async () => {
  const mock = recoveryMock(scenario);
  const state = await inspectRelease(mock.run, '0.6.0', '0.6.0', async () => assert.fail('已有 Tag 使用完整发布记录检查'));
  assert.equal(state.kind, kind); assert.equal(state.sha, recoverySha);
  assert.equal(mock.writes().length, 0);
});

for (const scenario of ['localTag', 'remoteTag', 'sha', 'tag', 'event', 'success', 'unverified', 'main', 'dirty']) test(`自动识别不放宽安全条件：${scenario}`, async () => {
  const mock = recoveryMock(scenario);
  await assert.rejects(inspectRelease(mock.run, '0.6.0', '0.6.0', async () => false));
  assert.equal(mock.writes().length, 0);
});

test('网络查询失败时停止，不能假定为全新或可恢复发布', async () => {
  await assert.rejects(inspectRelease(readOnlyQueries(mockGit(), fastRetries), '0.4.0', '0.3.0', async () => { throw new Error('ECONNRESET lookup'); }), /ECONNRESET lookup/);
  const mock = recoveryMock();
  await assert.rejects(inspectRelease(readOnlyQueries(async (program, args) => {
    if (program === 'gh' && args[0] === 'api') throw new Error('HTTP 503 fixture');
    return mock.run(program, args);
  }, fastRetries), '0.6.0', '0.6.0', async () => false), /HTTP 503 fixture/);
  assert.equal(mock.writes().length, 0);
});

test('已正式发布时仅显示完成信息和下载页面，不再询问或写入', async () => {
  const mock = recoveryMock('published'), harness = resultHarness();
  const state = await inspectRelease(mock.run, '0.6.0', '0.6.0', async () => false);
  await handleReleaseState(mock.run, { ask: async () => assert.fail('已发布无需询问') }, '0.6.0', state, { ui: harness.options.ui });
  assert.match(harness.messages.join('\n'), /v0.6.0 已经发布完成，无需重复发布[\s\S]*https:\/\/example.test\/release/);
  assert.equal(mock.writes().length, 0);
});

for (const flaw of ['empty', 'extra', 'draft', 'prerelease']) test(`已有 Release 不完整时拒绝重复发布：${flaw}`, async () => {
  const mock = recoveryMock('published');
  await assert.rejects(inspectRelease(async (program, args) => {
    const text = await mock.run(program, args);
    if (program !== 'gh' || args[0] !== 'api' || !args[1].includes('/releases?')) return text;
    const value = JSON.parse(text), release = value[0];
    if (flaw === 'empty') release.assets[0].size = 0;
    if (flaw === 'extra') release.assets.push({ name: 'extra.exe', size: 100 });
    if (flaw === 'draft') release.draft = true;
    if (flaw === 'prerelease') release.prerelease = true;
    return JSON.stringify(value);
  }, '0.6.0', '0.6.0', async () => false), /已有对应 Release/);
  assert.equal(mock.writes().length, 0);
});

for (const choice of ['1', '2']) test(`正在发布时只允许查看现有进度：${choice}`, async () => {
  const mock = recoveryMock('running'), harness = resultHarness();
  const state = await inspectRelease(mock.run, '0.6.0', '0.6.0', async () => false);
  let tracked = 0;
  await handleReleaseState(mock.run, { ask: async () => choice }, '0.6.0', state, { ui: harness.options.ui, track: async (run, version, sha, options) => {
    tracked++; assert.equal(sha, recoverySha); assert.equal(options.workflowId, recoveryId); assert.equal(options.attempt, 1);
  } });
  assert.equal(tracked, choice === '1' ? 1 : 0); assert.equal(mock.writes().length, 0);
});

for (const choice of ['continue', 'cancel', 'cancelFinal', 'dry']) test(`自动识别未完成发布后才询问并保留明确最终确认：${choice}`, async () => {
  const mock = recoveryMock(), harness = resultHarness();
  const state = await inspectRelease(mock.run, '0.6.0', '0.6.0', async () => false);
  const prompts = [], input = { ask: async (prompt) => {
    prompts.push(prompt);
    return prompt.includes('请输入完整') ? choice === 'cancelFinal' ? '取消' : '发布 v0.6.0' : choice === 'cancel' ? '2' : '1';
  } };
  const options = { ui: harness.options.ui, dry: choice === 'dry', track: async () => {} };
  if (choice === 'cancel' || choice === 'cancelFinal') await assert.rejects(handleReleaseState(mock.run, input, '0.6.0', state, options), /取消/);
  else await handleReleaseState(mock.run, input, '0.6.0', state, options);
  assert.equal(mock.writes().length, choice === 'continue' ? 1 : 0);
  assert.equal(prompts.length, choice === 'dry' ? 0 : choice === 'cancel' ? 1 : 2);
  const text = harness.messages.join('\n');
  assert.match(text, /检测到上次发布未完成[\s\S]*已取消[\s\S]*正式构建尚未完成/);
  assert.doesNotMatch(text, /Tag SHA|Workflow \/ attempt|请补充|粘贴/);
});

test('--help 保留全部兼容选项并介绍统一输入', async () => {
  const output = await command(root)(process.execPath, ['scripts/release.mjs', '--help']);
  for (const option of ['--dry-run', '--restore', '--verbose', ':end', ':cancel', 'Enter', '自动检查发布状态']) assert.ok(output.includes(option));
  assert.doesNotMatch(output, /恢复失败的发布|请选择/);
});

for (const message of ['write: broken pipe', 'ECONNRESET', 'ETIMEDOUT', 'TLS connection was non-properly terminated', 'LibreSSL SSL_connect: SSL_ERROR_SYSCALL', 'HTTP 503', 'unexpected EOF']) test(`只读临时网络错误自动恢复：${message}`, async () => {
  let calls = 0;
  const sleeps = [], notices = [];
  const result = await retryReadOnly(async () => { if (++calls === 1) throw new Error(message); return 'ok'; }, {
    sleep: async ms => sleeps.push(ms), notify: text => notices.push(text),
  });
  assert.equal(result, 'ok'); assert.equal(calls, 2); assert.deepEqual(sleeps, [1000]);
  assert.match(notices[0], /GitHub 连接中断，正在重试（2\/5）/);
  assert.ok(notices[0].includes(message));
});

test('只读查询最多五次，按 1/2/4/8 秒退避并保留最后具体错误', async () => {
  const failures = [], sleeps = [], notices = [];
  await assert.rejects(retryReadOnly(async () => {
    const error = new Error(`write: broken pipe ${failures.length + 1}`); failures.push(error); throw error;
  }, { sleep: async ms => sleeps.push(ms), notify: text => notices.push(text) }), error => error === failures[4]);
  assert.equal(failures.length, 5); assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
  assert.equal(notices.length, 4); assert.match(notices.at(-1), /5\/5/);
});

for (const message of ['HTTP 401 Bad credentials', 'HTTP 403 Forbidden', 'gh not authenticated', 'spawn gh ENOENT', 'certificate verify failed', 'Tag SHA mismatch']) test(`认证、配置或业务错误不重试：${message}`, async () => {
  let calls = 0;
  await assert.rejects(retryReadOnly(async () => { calls++; throw new Error(message); }, {
    sleep: async () => assert.fail('不得等待重试'),
  }), error => error.message === message);
  assert.equal(calls, 1);
});

test('fetch 的底层网络错误及真实子进程超时可被识别', async () => {
  let calls = 0;
  await retryReadOnly(async () => {
    if (++calls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  }, fastRetries);
  assert.equal(calls, 2);
  await assert.rejects(command(root)(process.execPath, ['-e', 'setInterval(()=>{},1000)'], false, 50), error => error.code === 'ETIMEDOUT');
});

for (const [program, args, expected] of [
  ['gh', ['api', 'repos/lishangyang290/windowstash/actions/runs/39209631988'], 5],
  ['gh', ['auth', 'status'], 5], ['git', ['ls-remote', 'origin', 'refs/heads/main'], 5],
  ['gh', ['run', 'rerun', '39209631988'], 1], ['git', ['push', 'origin', 'main'], 1],
  ['gh', ['release', 'create', 'v0.6.0'], 1],
  ['gh', ['api', 'repos/lishangyang290/windowstash/actions/runs/39209631988/rerun', '--method', 'POST'], 1],
]) test(`自动重试严格区分只读与写操作：${program} ${args.join(' ')}`, async () => {
  let calls = 0;
  const execute = readOnlyQueries(async () => { calls++; throw new Error('write: broken pipe'); }, fastRetries);
  await assert.rejects(readOnlyQueries(execute)(program, args), /broken pipe/);
  assert.equal(calls, expected);
});

test('正常发布的远端引用与 Release 存在性检查均可恢复临时错误', async () => {
  const git = mockGit(); let references = 0, releases = 0;
  const execute = readOnlyQueries(async (program, args, live, timeout) => {
    if (args[0] === 'ls-remote') {
      assert.equal(timeout, 30000);
      if (++references === 1) throw new Error('ECONNRESET git');
    }
    return git(program, args);
  }, fastRetries);
  await checkRemote(execute, '0.4.0', head, async () => { if (++releases < 3) throw new Error('HTTP 502'); return false; });
  assert.equal(references, 3); assert.equal(releases, 3);
});

for (const scenario of ['recover', 'continuous', 'auth']) test(`最终确认后的二次验证保留并有限重试：${scenario}`, async () => {
  const mock = recoveryMock(), harness = resultHarness();
  let validations = 0, authChecks = 0, tracked = 0;
  const notices = [];
  const execute = readOnlyQueries(async (program, args) => {
    if (program === 'gh' && args[0] === 'auth' && ++authChecks === 2 && scenario === 'auth') throw new Error('HTTP 401 Bad credentials');
    if (program === 'gh' && args[0] === 'api' && args[1].includes('event=workflow_dispatch')) {
      validations++;
      if (validations > 1 && (scenario === 'continuous' || scenario === 'recover' && validations === 2)) throw new Error('write: broken pipe final validation');
    }
    return mock.run(program, args);
  }, { ...fastRetries, notify: text => notices.push(text) });
  const input = { ask: async prompt => prompt.includes('请输入完整') ? '发布 v0.6.0' : '1' };
  const options = { ui: harness.options.ui, track: async () => { tracked++; } };
  if (scenario === 'recover') await recoverRelease(execute, input, '0.6.0', options);
  else await assert.rejects(recoverRelease(execute, input, '0.6.0', options), scenario === 'auth' ? /HTTP 401 Bad credentials/ : /broken pipe final validation/);
  assert.equal(mock.writes().length, scenario === 'recover' ? 1 : 0);
  assert.equal(tracked, scenario === 'recover' ? 1 : 0);
  assert.equal(validations, scenario === 'continuous' ? 6 : scenario === 'recover' ? 3 : 1);
  assert.equal(notices.length, scenario === 'continuous' ? 4 : scenario === 'recover' ? 1 : 0);
});

for (const scenario of ['started', 'unchanged', 'unknown', 'wrongSha']) test(`重跑响应丢失后只读核实 attempt，绝不重复重跑：${scenario}`, async () => {
  const mock = recoveryMock(), harness = resultHarness();
  let writes = 0, reads = 0, tracked = 0;
  const execute = readOnlyQueries(async (program, args) => {
    if (program === 'gh' && args[0] === 'run') { writes++; throw new Error('write: broken pipe rerun response'); }
    if (writes && program === 'gh' && args[0] === 'api') {
      reads++;
      assert.ok(args[1].endsWith(`actions/runs/${recoveryId}`));
      if (scenario === 'unknown') throw new Error('ECONNRESET attempt query');
      return JSON.stringify(recoveryWorkflow({ run_attempt: scenario === 'unchanged' ? 1 : 2, status: 'in_progress', conclusion: null,
        head_sha: scenario === 'wrongSha' ? 'c'.repeat(40) : recoverySha }));
    }
    return mock.run(program, args);
  }, fastRetries);
  const input = { ask: async prompt => prompt.includes('请输入完整') ? '发布 v0.6.0' : '1' };
  const options = { ui: harness.options.ui, track: async (run, version, sha, target) => {
    tracked++; assert.equal(target.workflowId, recoveryId); assert.equal(target.attempt, 2); assert.equal(sha, recoverySha);
  } };
  if (scenario === 'started') await recoverRelease(execute, input, '0.6.0', options);
  else await assert.rejects(recoverRelease(execute, input, '0.6.0', options), /broken pipe rerun response[\s\S]*禁止盲目重试/);
  assert.equal(writes, 1); assert.equal(reads, scenario === 'unknown' ? 5 : 1);
  assert.equal(tracked, scenario === 'started' ? 1 : 0);
  if (scenario === 'started') assert.match(harness.messages.join('\n'), /已只读确认新的构建/);
});
