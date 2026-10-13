import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { command, npmInvocation, parseRelease, validateInput, planFiles, applyFiles, restoreFiles, saveJournal, recoverPrepared, preflight, runChecks, publish } from './release-core.mjs';
import { terminalUI, presentedCommand, workflowProgress, liveProgress } from './release-ui.mjs';
import { inputLines, editRelease, showResult } from './release.mjs';

const root = resolve(import.meta.dirname, '..');
const standard = '当前版本：v0.3.0\n目标版本：0.4.0\n\n更新内容：\n- 修复重启后关联丢失\n- 新增教程入口\n\nmain HEAD：\n56b8e2fe30517972e54cfe9a5ba4befd822f924c\n测试：\n224 项通过';
const silent = new Writable({ write(chunk, encoding, done) { done(); } });
const releaseAssets = () => ['macOS-arm64.zip', 'Windows-x64.zip', 'Windows-x64-setup.exe'].map((suffix) => ({ name: `WindowStash-v0.4.0-${suffix}`, size: 100, url: 'https://example.test/download.zip' }));

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

for (const scenario of ['macOnly', 'windowsOnly', 'missingInstaller', 'emptyWindows', 'draft', 'prerelease', 'failed', 'complete']) test(`双平台正式发布完整性：${scenario}`, async () => {
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
    if (scenario === 'missingInstaller') assets = assets.slice(0, 2);
    if (scenario === 'emptyWindows') assets[1].size = 0;
    return JSON.stringify({ isDraft: scenario === 'draft', isPrerelease: scenario === 'prerelease', assets });
  }, '0.4.0', 'abc', harness.options);
  assert.equal(harness.messages.some((text) => text.includes('发布成功')), scenario === 'complete');
});

test('手动 Actions 验证没有写权限或发布路径，只有统一 Tag 发布任务可写', async () => {
  const source = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /permissions:\s+contents: read/);
  const [build, publish] = source.split('\n  publish:');
  assert.doesNotMatch(build, /contents: write|gh release|publish-release\.mjs/);
  assert.match(publish, /needs: build/);
  assert.match(publish, /if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/v'\)/);
  assert.match(publish, /contents: write/);
  assert.equal((source.match(/run: node scripts\/publish-release.mjs/g) ?? []).length, 1);
});

for (const scenario of ['success', 'existing', 'uploadFailure', 'missingAsset', 'corruptDownload', 'wrongTag', 'manual']) test(`统一发布任务安全流程（完全模拟 gh）：${scenario}`, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'windowstash-publish-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = releaseAssets().map((asset) => asset.name).sort();
  await mkdir(resolve(directory, 'release-assets'));
  await mkdir(resolve(directory, '.github/release-notes'), { recursive: true });
  for (const name of names) await writeFile(resolve(directory, 'release-assets', name), 'fixture artifact', 'utf8');
  await writeFile(resolve(directory, '.github/release-notes/v0.4.0.md'), '- 模拟更新说明\n', 'utf8');
  const mock = resolve(directory, 'gh-mock.mjs');
  await writeFile(mock, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
 if (args[1] === 'view') return ok({isDraft:true,isPrerelease:false,assets:(scenario === 'missingAsset' ? names.slice(1) : names).map(name => ({name,size:16}))});
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
    cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: scenario === 'manual' ? 'workflow_dispatch' : 'push', GITHUB_REF: 'refs/tags/v0.4.0', GITHUB_REF_NAME: 'v0.4.0', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'lishangyang290/windowstash' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stderr);
  const calls = scenario === 'manual' ? [] : (await readFile(resolve(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[1] === 'edit'), scenario === 'success');
  assert.ok(calls.every((args) => !args.includes('--clobber')));
  if (['existing', 'wrongTag', 'manual'].includes(scenario)) assert.ok(!calls.some((args) => args[1] === 'create'));
  else assert.ok(calls.find((args) => args[1] === 'create')?.includes('--draft'));
  if (scenario === 'success') {
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
  let polls = 0;
  await showResult(async (program, args, live, timeout) => {
    calls.push(args);
    assert.ok(timeout > 0 && timeout <= 30000);
    if (args[0] === 'auth') return '';
    if (args[1] === 'list') { polls++; return JSON.stringify([actionRun()]); }
    if (args[0] === 'run') return JSON.stringify(actionRun(polls === 2 ? 'completed' : 'in_progress', polls === 2 ? 'success' : null));
    return JSON.stringify({ url: 'https://example.test/release', isDraft: false, isPrerelease: false, assets: releaseAssets() });
  }, '0.4.0', 'abc', harness.options);
  assert.equal(polls, 2);
  assert.ok(calls.filter((args) => args[1] === 'list').every((args) => args[args.indexOf('--event') + 1] === 'push'));
  assert.ok(calls.some((args) => args[1] === 'view' && args[2] === '123' && args.includes('status,conclusion,url,headBranch,headSha,jobs')));
  assert.ok(harness.snapshots.some(({ lines, elapsed }) => elapsed === 12000 && lines[1].includes('已结束 1/1')));
  assert.match(harness.messages.join('\n'), /发布成功[\s\S]*ZIP 下载.*download.zip/);
});

for (const scenario of ['network', 'timeout', 'foreignCommit', 'foreignTag', 'cancelled', 'emptyZip', 'prerelease']) test(`Actions 保留实际状态且禁止误报成功：${scenario}`, async () => {
  const harness = resultHarness(); let polls = 0, releaseQueries = 0;
  if (scenario === 'timeout') harness.options.timeout = 12000;
  if (scenario === 'cancelled') harness.options.active = () => { if (polls) throw new Error('用户取消'); };
  if (scenario.startsWith('foreign')) harness.options.wait = false;
  await showResult(async (program, args) => {
    if (args[0] === 'auth') return '';
    if (args[1] === 'list') {
      polls++;
      if (scenario === 'network' && polls === 2) throw new Error('network');
      const workflow = actionRun();
      if (scenario === 'foreignCommit') workflow.headSha = 'other';
      if (scenario === 'foreignTag') workflow.headBranch = 'v0.5.0';
      return JSON.stringify([workflow]);
    }
    if (args[0] === 'run') return JSON.stringify(actionRun(['emptyZip', 'prerelease'].includes(scenario) ? 'completed' : 'in_progress', ['emptyZip', 'prerelease'].includes(scenario) ? 'success' : null));
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

test('父 Workflow 状态不变时，Extension、Companion、ZIP、上传任务仍按真实 Step 更新', async () => {
  const harness = resultHarness(), names = ['Validate Extension', 'Build Companion app', 'Assemble macOS package', 'Create GitHub Release and upload macOS asset'];
  let index = -1;
  await showResult(async (program, args) => {
    if (args[0] === 'auth') return '';
    if (args[1] === 'list') { index++; return JSON.stringify([actionRun()]); }
    if (args[0] === 'run') {
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
test('手动修改版本和说明', async () => {
  const input = io(['目标版本：0.4.0', '- 修复关联', ':end', '2', '0.5.0', '3', '- 新增教程', ':end', '1']);
  const result = await editRelease(input, '0.3.0', () => {});
  assert.equal(result.version, '0.5.0'); assert.deepEqual(result.notes, ['新增教程']); input.close();
});
test('冲突版本人工选择', async () => {
  const input = io(['目标版本：0.4.0 或 0.5.0', '- 修复关联', ':end', '2', '1']);
  assert.equal((await editRelease(input, '0.3.0', () => {})).version, '0.5.0'); input.close();
});
test('重新粘贴以及用户取消', async () => {
  const input = io(['WindowStash v0.4.0', '- 修复关联', ':end', '4', '版本：0.5.0', '- 新增教程', ':end', '5']);
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
  assert.ok(!(await readFile(resolve(directory, 'public/开始使用.html'), 'utf8')).includes('WindowStash-v0.3.0'));
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
  const preview = async (verbose = false) => new Promise((done, fail) => {
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(directory, 'fetch-mock.mjs')).href, 'scripts/release.mjs', '--dry-run', ...(verbose ? ['--verbose'] : [])], { cwd: directory, env: childEnv });
    let text = ''; child.stdout.on('data', (data) => { text += data; }); child.stderr.on('data', (data) => { text += data; }); child.on('error', fail); child.on('close', (code) => code === 0 ? done(text) : fail(new Error(text)));
    child.stdin.end(standard + '\n:end\n1\n');
  });
  const output = await preview();
  assert.match(output, /预演通过/);
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
      child.stdin.end(standard + '\n:end\n1\n' + (scenario === 'cancel' ? '取消' : '发布 v0.4.0') + '\n');
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
  const input = io(['无法识别的摘要', ':end', '0.4.0', '- 新增教程', ':end', '1']);
  const result = await editRelease(input, '0.3.0', () => {});
  assert.equal(result.version, '0.4.0'); assert.deepEqual(result.notes, ['新增教程']); input.close();
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
test('回归：多行粘贴、识别确认和手动修改完整说明', async () => {
  const input = io(['WindowStash v0.4.0', '', '更新内容：', ...reportedNotes.map((note) => `• ${note}`), ':end', '2', '0.5.0', '1']);
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
test('验收：手动编辑支持 • 列表符号', async () => {
  const input = io(['WindowStash v0.4.0', '- 新增教程', ':end', '3', '• 优化关联', '• 提高稳定性', ':end', '1']);
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
