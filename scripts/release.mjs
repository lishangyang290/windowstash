import { terminalUI, presentedCommand, workflowProgress, liveProgress } from './release-ui.mjs';
import { createInterface } from 'node:readline';
import { readFile, unlink, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseRelease, command, localState, preflight, checkRemote, planFiles, applyFiles, saveJournal, recoverPrepared, runChecks, publish, recoveryPlan, inspectRelease, readOnlyQueries, versionPattern, repository } from './release-core.mjs';

export function inputLines(input, output) {
  const ui = terminalUI(output);
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  rl.on('SIGINT', () => { rl.close(); process.emit('SIGINT'); });
  const iterator = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt) {
      output.write(ui.prompt(prompt));
      const next = await iterator.next();
      if (next.done || next.value.trim() === ':cancel') throw new Error('输入已结束或用户取消，发布取消。');
      return next.value.trim();
    },
    async paste(prompt, versionShortcut = false) {
      output.write(ui.paste(prompt));
      const lines = [];
      while (true) {
        const next = await iterator.next();
        if (next.done || next.value.trim() === ':cancel') throw new Error('发布取消。');
        if (next.value.trim() === ':end') return lines.join('\n');
        if (versionShortcut && lines.every(line => !line.trim()) && /^v?\d+\.\d+\.\d+$/.test(next.value.trim())) return next.value.trim();
        lines.push(next.value);
      }
    },
    close: () => rl.close(),
  };
}

export async function editRelease(io, current, log = console.log) {
  const ui = terminalUI(process.stdout, log);
  ui.section('发布信息');
  const source = await io.paste('请输入要发布的版本，或粘贴完整发布信息。单独版本号可直接按 Enter 提交。', true);
  const result = /^v?\d+\.\d+\.\d+$/.test(source.trim())
    ? { version: source.trim().replace(/^v/, ''), notes: [] } : parseRelease(source);
  if (!result.version && result.candidates?.length > 1) {
    ui.warning('检测到多个目标版本，请选择。');
    ui.list(result.candidates.map((v, i) => `${i + 1}.  v${v}`));
    const choice = await io.ask('请选择编号，或直接输入目标 X.Y.Z：');
    result.version = result.candidates[Number(choice) - 1] ?? choice.replace(/^v/, '');
  }
  if (!result.version) result.version = (await io.ask('未识别目标版本，请输入 X.Y.Z：')).replace(/^v/, '');
  if (!versionPattern.test(result.version)) throw new Error('目标版本必须为 X.Y.Z，不能含前导零或预发布后缀。');
  ui.field('目标版本', ui.bold(`v${result.version}`));
  return result;
}
const manualNotes = (text) => text.split('\n').map((line) => line.trim().replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/, '')).filter(Boolean);

export async function confirmRelease(io, current, input, log = console.log) {
  const ui = terminalUI(process.stdout, log);
  while (true) {
    if (!input.notes.length) input.notes = manualNotes(await io.paste('请补充本次更新说明，每行一条。'));
    ui.section('确认识别结果');
    ui.field('目标版本', ui.bold(`v${input.version}`));
    ui.hint('更新说明');
    ui.list(input.notes.map(note => `- ${note}`));
    ui.list(['1. 不需要，继续', '2. 修改目标版本', '3. 修改更新说明', '4. 重新粘贴', '5. 取消']);
    const choice = await io.ask('是否需要修改发布信息？');
    if (choice === '1' && input.notes.length) return input;
    if (choice === '2') {
      const version = (await io.ask('请输入目标 X.Y.Z：')).replace(/^v/, '');
      if (versionPattern.test(version)) input.version = version;
      else ui.warning('目标版本必须为 X.Y.Z，不能含前导零或预发布后缀。');
    } else if (choice === '3') input.notes = manualNotes(await io.paste('请输入更新说明，每行一条。'));
    else if (choice === '4') input = await editRelease(io, current, log);
    else if (choice === '5') throw new Error('用户取消发布。');
    else ui.warning('请选择 1 至 5；更新说明不能为空。');
  }
}

export async function releaseExists(version) {
  const response = await globalThis.fetch(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, {
    headers: { Accept: 'application/vnd.github+json' }, signal: globalThis.AbortSignal.timeout(20000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`无法确认 GitHub Release 是否存在（HTTP ${response.status}），请检查网络或 API 限额后重试。`);
  return true;
}

export async function recoverRelease(run, io, version, {
  ui = terminalUI(), dry = false, active = () => {}, track = showResult, display = liveProgress(), verbose = false,
} = {}) {
  const plan = await recoveryPlan(run, version);
  ui.section('检测到上次发布未完成');
  ui.field('版本', plan.tag);
  ui.field('上次状态', plan.conclusion === 'cancelled' ? '已取消' : '失败');
  ui.field('原因', plan.conclusion === 'cancelled' ? '正式构建尚未完成' : '上次正式构建未通过，请查看构建详情');
  ui.field('接下来', '重新运行 Windows 和 macOS 构建，完成正式发布');
  ui.field('构建详情', plan.url);
  if (verbose) {
    ui.field('Tag SHA', plan.sha);
    ui.field('Workflow / attempt', `${plan.workflowId} / ${plan.attempt}`);
    ui.field('双平台验证', `https://github.com/${repository}/actions/runs/${plan.validationId}`);
  }
  if (dry) { ui.hint('只读预演结束，未重新运行 Workflow。'); return; }
  ui.list(['1.  继续', '2.  取消']);
  if (await io.ask('是否继续完成本次发布？') !== '1') throw new Error('用户取消发布。');
  if (await io.ask(`请输入完整的「发布 ${plan.tag}」确认，其他输入均取消：`) !== `发布 ${plan.tag}`) throw new Error('用户取消恢复发布。');
  active();
  if (JSON.stringify(await recoveryPlan(run, version)) !== JSON.stringify(plan)) throw new Error('确认期间恢复条件发生变化，请重新检查，未重跑 Workflow。');
  active();
  try { await run('gh', ['run', 'rerun', String(plan.workflowId), '--repo', repository], false, 30000); }
  catch (error) {
    let latest;
    try {
      latest = JSON.parse(await readOnlyQueries(run)('gh', ['api', `repos/${repository}/actions/runs/${plan.workflowId}`], false, 30000));
    } catch (queryError) {
      throw new Error(`重跑响应未确认：${error.message}；查询最新 attempt 失败：${queryError.message}。请先查看 ${plan.url}，禁止盲目重试。`, { cause: queryError });
    }
    if (latest.id !== plan.workflowId || latest.event !== 'push' || latest.path !== '.github/workflows/release.yml'
      || latest.head_sha !== plan.sha || latest.head_branch !== plan.tag || latest.run_attempt !== plan.attempt + 1) {
      throw new Error(`重跑请求未确认：${error.message}；远端 attempt 为 ${latest.run_attempt ?? '未知'}，未确认本次新构建。请先查看 ${plan.url}，禁止盲目重试。`, { cause: error });
    }
    ui.warning(`重跑请求响应中断，已只读确认新的构建，继续查看进度。诊断：${error.message}`);
  }
  ui.hint('已请求重新构建，正在等待启动（最多 15 分钟）。');
  await track(run, version, plan.sha, { wait: true, active, ui, display, verbose, workflowId: plan.workflowId, attempt: plan.attempt + 1 });
}

export async function handleReleaseState(run, io, version, state, {
  ui = terminalUI(), dry = false, active = () => {}, track = showResult, display = liveProgress(), verbose = false,
} = {}) {
  if (state.kind === 'new') return false;
  if (state.kind === 'published') {
    ui.success(`v${version} 已经发布完成，无需重复发布。`);
    ui.field('下载页面', state.releaseUrl);
  } else if (state.kind === 'recover') {
    await recoverRelease(run, io, version, { ui, dry, active, track, display, verbose });
  } else if (state.kind === 'running') {
    ui.hint(`v${version} 正在构建，无需重复启动。`);
    ui.field('构建详情', state.url);
    if (!dry) {
      ui.list(['1.  查看现有进度', '2.  取消']);
      if (await io.ask('是否继续查看进度？') === '1') await track(run, version, state.sha, {
        wait: true, active, ui, display, verbose, workflowId: state.workflowId, attempt: state.attempt,
      });
    }
  } else throw new Error('无法确定发布状态，已安全停止。');
  return true;
}

export async function showResult(run, version, commit, {
  wait = false, active = () => {}, ui = terminalUI(), display = liveProgress(),
  now = Date.now, sleep = (ms) => new Promise((done) => globalThis.setTimeout(done, ms)),
  timeout = 15 * 60 * 1000,
  fetch: request = globalThis.fetch,
  workflowId, attempt, verbose = false,
} = {}) {
  if (workflowId !== undefined && (!Number.isSafeInteger(workflowId) || workflowId < 1 || !Number.isSafeInteger(attempt) || attempt < 1)) throw new Error('Workflow ID 或 attempt 无效。');
  const releaseUrl = `https://github.com/${repository}/releases/tag/v${version}`;
  ui.section('步骤 4 / 4 · 发布结果');
  ui.field('版本', `v${version}`);
  if (verbose) {
    ui.field('版本提交', commit);
    if (workflowId) ui.field('跟踪目标', `Workflow ${workflowId} · attempt ${attempt}`);
  }
  ui.field('构建详情', workflowId ? `https://github.com/${repository}/actions/runs/${workflowId}` : `https://github.com/${repository}/actions/workflows/release.yml`);
  if (verbose) ui.field('Release 页面', releaseUrl);
  const started = now(), deadline = started + timeout;
  let workflow, timer, publicApi = false, connection = '';
  const diagnostics = [];
  let lines = workflowProgress();
  const render = (tick = false) => display.update(connection ? [`${connection} · ${lines[0]}`, lines[1], lines[2]] : lines, now() - started, tick);
  const pause = async (until) => {
    while (now() < until) {
      await sleep(Math.min(1000, until - now()));
      active();
    }
  };
  const api = async (path) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('等待超时');
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Accept: 'application/vnd.github+json' }, signal: globalThis.AbortSignal.timeout(Math.min(30000, remaining)),
    });
    if (!response.ok) throw new Error(`公开 API ${path} HTTP ${response.status}：${await response.text()}`);
    return response.json();
  };
  const publicQuery = async (args) => {
    if (args[0] === 'auth') return '';
    if (args[0] === 'api') return JSON.stringify(await api(args[1].slice(`repos/${repository}/`.length)));
    if (args[0] === 'release') {
      const release = await api(`releases/tags/v${version}`);
      return JSON.stringify({ url: release.html_url, isDraft: release.draft, isPrerelease: release.prerelease,
        assets: release.assets.map((asset) => ({ ...asset, url: asset.browser_download_url })) });
    }
    const normalize = (item) => ({ ...item, databaseId: item.id, headSha: item.head_sha, headBranch: item.head_branch, url: item.html_url });
    if (args[1] === 'list') {
      const result = await api(`actions/workflows/release.yml/runs?event=push&head_sha=${commit}&per_page=10`);
      return JSON.stringify(result.workflow_runs.map(normalize));
    }
    const detail = normalize(await api(`actions/runs/${args[2]}`));
    const jobs = [];
    for (let page = 1; ; page++) {
      const result = await api(`actions/runs/${args[2]}/jobs?per_page=100&page=${page}`);
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) break;
    }
    return JSON.stringify({ ...detail, jobs });
  };
  const query = async (args) => {
    let failures = 0;
    while (true) {
      active();
      if (now() >= deadline) throw new Error('等待超时');
      const provider = publicApi ? '公开 API' : `gh ${args.join(' ')}`;
      try {
        const result = publicApi ? await publicQuery(args) : await run('gh', args, false, Math.min(30000, deadline - now()));
        active();
        if (now() >= deadline) throw new Error('等待超时');
        connection = '';
        return result;
      } catch (error) {
        active();
        const cause = `${provider}：${error.message}${error.cause?.message ? `；${error.cause.message}` : ''}`;
        diagnostics.push(cause);
        if (!publicApi && (error.code === 'ENOENT' || /not logged|not authenticated|authentication|auth login|token.*invalid|HTTP 401|HTTP 403|ENOENT/i.test(error.message))) {
          publicApi = true;
          connection = 'gh 不可用，切换公开只读 API';
          render();
          continue;
        }
        if (!wait || now() >= deadline) throw error;
        connection = `查询失败，正在重试（${++failures}）`;
        render();
        await pause(Math.min(now() + 12000, deadline));
      }
    }
  };
  try {
    render();
    timer = globalThis.setInterval(() => {
      try { active(); render(true); }
      catch { globalThis.clearInterval(timer); }
    }, 1000);
    await query(['auth', 'status']);
    while (true) {
      active();
      const queriedAt = now();
      if (workflowId) {
        const remote = async (path) => JSON.parse(await query(['api', `repos/${repository}/${path}`]));
        const detail = await remote(`actions/runs/${workflowId}`);
        if (detail.id !== workflowId || detail.event !== 'push' || detail.path !== '.github/workflows/release.yml'
          || detail.head_sha !== commit || detail.head_branch !== `v${version}` || !Number.isSafeInteger(detail.run_attempt) || detail.run_attempt < 1
          || detail.run_attempt > attempt) throw new Error('Workflow、Tag、SHA 或 run_attempt 与恢复目标不匹配');
        if (detail.run_attempt === attempt) {
          const jobs = [];
          for (let page = 1; ; page++) {
            const result = await remote(`actions/runs/${workflowId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
            jobs.push(...result.jobs);
            if (result.jobs.length < 100) break;
          }
          workflow = { databaseId: detail.id, status: detail.status, conclusion: detail.conclusion, url: detail.html_url, jobs };
          lines = workflowProgress(workflow);
          if (verbose) lines[0] += ` · attempt ${attempt}`;
        } else connection = verbose ? `等待新的 attempt ${attempt}（远端仍为 ${detail.run_attempt}）` : '正在等待本次构建启动';
      } else {
        const runs = workflow ? [workflow] : JSON.parse(await query(['run', 'list', '--repo', repository, '--workflow', 'release.yml', '--event', 'push', '--commit', commit, '--limit', '10', '--json', 'databaseId,status,conclusion,url,headBranch,headSha']));
        const match = runs.find((item) => item.headBranch === `v${version}` && item.headSha === commit);
        if (match) {
          workflow = workflow?.databaseId === match.databaseId ? { ...workflow, ...match } : match;
          lines = workflowProgress(workflow);
          const detail = JSON.parse(await query(['run', 'view', String(match.databaseId), '--repo', repository, '--json', 'status,conclusion,url,headBranch,headSha,jobs']));
          if (detail.headSha !== commit || detail.headBranch !== `v${version}`) throw new Error('Workflow 与发布提交或 Tag 不匹配');
          workflow = { ...match, ...detail };
          lines = workflowProgress(workflow);
        }
      }
      render();
      if (workflow?.status === 'completed') break;
      if (!wait) { ui.warning('正在等待构建完成；Release 尚未确认，请查看上述页面。'); return; }
      const nextPoll = Math.min(queriedAt + 12000, deadline);
      await pause(nextPoll);
    }
    globalThis.clearInterval(timer);
    if (workflow.conclusion !== 'success') {
      ui.field('构建详情', workflow.url);
      ui.error(`构建未成功：${workflow.conclusion}。请打开 Workflow 查看日志。`);
      return;
    }
    if (workflowId) {
      if (!['Windows x64', 'macOS arm64', 'Publish complete Release'].every((name) => workflow.jobs.some((job) => job.name === name && job.status === 'completed' && job.conclusion === 'success'))) throw new Error('恢复后的双平台或 Publish Job 未全部成功，禁止确认发布。');
      const tag = JSON.parse(await query(['api', `repos/${repository}/git/ref/tags/v${version}`]));
      if (tag.object?.type !== 'commit' || tag.object.sha !== commit) throw new Error('发布后远端 Tag SHA 已改变，禁止确认发布。');
    }
    const release = JSON.parse(await query(['release', 'view', `v${version}`, '--repo', repository, '--json', 'assets,url,isDraft,isPrerelease']));
    const names = [`WindowStash-v${version}-macOS-arm64.zip`, `WindowStash-v${version}-Windows-x64.zip`];
    const assets = names.map((name) => release.assets.find((asset) => asset.name === name && asset.size > 0));
    ui.field('构建详情', workflow.url);
    if (!release.isDraft && !release.isPrerelease && assets.every(Boolean)
      && JSON.stringify(release.assets.map((asset) => asset.name).sort()) === JSON.stringify([...names].sort())) {
      ui.success(`发布成功，macOS 与 Windows 正式附件已生成：${release.url}`);
      for (const [index, label] of ['macOS ZIP 下载', 'Windows ZIP 下载'].entries()) {
        const asset = assets[index];
        ui.field(label, asset.url || `https://github.com/${repository}/releases/download/v${version}/${asset.name}`);
      }
    }
    else ui.warning('构建已结束，但正式 Release 或双平台完整附件尚未确认，请查看页面。');
  } catch (error) {
    diagnostics.push(error.message);
    let cancelled = false;
    try { active(); } catch { cancelled = true; }
    render();
    if (workflow?.url) ui.field('最后确认的构建详情', workflow.url);
    ui.warning(cancelled ? '已结束等待；以上为最后查询的实际状态，Release 尚未确认，请打开远端页面。'
      : now() >= deadline ? '等待超时；以上为最后查询的实际状态，Release 尚未确认，请打开远端页面。'
      : '无法自动确认远端状态；以上为最后查询的实际状态，请查看 GitHub 页面及下方查询诊断。Tag 推送成功不代表 Release 已完成。');
  } finally {
    globalThis.clearInterval(timer);
    for (const diagnostic of [...new Set(diagnostics)]) ui.field('查询诊断', diagnostic.replace(/[\p{Cc}\p{Cf}]/gu, ' '));
  }
}

export async function main(args = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const journalPath = resolve(root, '.windowstash-release.json');
  const dry = args.includes('--dry-run');
  const ui = terminalUI();
  const verbose = args.includes('--verbose');
  if (args.some((arg) => !['--dry-run', '--restore', '--help', '--verbose'].includes(arg)) || (dry && args.includes('--restore'))) throw new Error('参数无效。用法：npm run release -- [--dry-run | --restore | --help] [--verbose]');
  if (args.includes('--help')) {
    ui.section('WindowStash Release');
    ui.list(['双击 WindowStash Release.command（macOS）或 WindowStash Release.cmd（Windows），也可 npm run release', '', '--dry-run   只读预演', '--restore   恢复未提交的发布准备', '--verbose   显示底层命令及完整检查输出']);
    ui.hint('单独输入版本号可按 Enter 提交；多行内容以 :end 结束，:cancel 取消。输入后自动检查发布状态。');
    return;
  }
  const run = presentedCommand(command(root), ui, verbose);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请安装 Node.js 22 或更新的 LTS 版本。');
  if (args.includes('--restore')) {
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    await recoverPrepared(run, root, journal);
    await unlink(journalPath);
    ui.success('已恢复工具准备的版本文件；其他文件未被清理。');
    return;
  }
  try { await access(journalPath); throw new Error('存在未完成发布记录 .windowstash-release.json。未提交时可运行 npm run release -- --restore；已提交时请按记录检查远端，禁止盲目重试。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const io = inputLines(process.stdin, process.stdout);
  let journal;
  let publishing = false;
  let interrupted = false;
  const interrupt = () => { interrupted = true; io.close(); ui.warning('收到中断；将停止后续发布步骤，已有准备可通过 --restore 恢复。'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const ensureActive = () => { if (interrupted) throw new Error('发布已中断。'); };
  const guardedRun = async (...params) => { ensureActive(); const result = await run(...params); ensureActive(); return result; };
  try {
    const current = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
    const initial = await localState(run);
    ui.section('WindowStash Release');
    if (dry) ui.hint('只读预演 · 不写入文件，不提交或推送');
    ui.field('当前版本', ui.bold(`v${current}`));
    ui.field('当前分支', ui.bold(initial.branch));
    if (initial.status) ui.warning('Git 状态：有未提交改动');
    else ui.success('Git 状态：正常');
    let input = await editRelease(io, current);
    let { version } = input;
    ui.section('步骤 2 / 4 · 检查发布条件');
    ui.pending('检查当前版本和远端发布状态');
    let detected;
    try { detected = await inspectRelease(guardedRun, version, current, releaseExists); }
    catch (error) { throw new Error(`无法确认 v${version} 的发布状态，未执行发布操作：${error.message}`, { cause: error }); }
    if (await handleReleaseState(guardedRun, io, version, detected, { ui, dry, active: ensureActive, verbose, display: liveProgress(process.stdout, undefined, !verbose) })) return;
    input = await confirmRelease(io, current, input);
    if (input.version !== version) {
      version = input.version;
      detected = await inspectRelease(guardedRun, version, current, releaseExists);
      if (await handleReleaseState(guardedRun, io, version, detected, { ui, dry, active: ensureActive, verbose, display: liveProgress(process.stdout, undefined, !verbose) })) return;
    }
    const notes = input.notes;
    const state = await preflight(guardedRun, version, current, notes, releaseExists);
    ui.success('版本和远端状态检查');
    await guardedRun(process.execPath, ['scripts/validate-release-version.mjs', current], true);
    const files = await planFiles(root, version, notes);
    if (dry) {
      ui.section('预演结果');
      ui.success(`预演通过：v${current} → v${version}`);
      ui.hint('预期修改');
      ui.list(files.map((f) => f.path));
      ui.hint('发布计划');
      ui.field('Commit', `chore(release): v${version}`);
      ui.field('Tag', `v${version}`);
      ui.field('仓库', repository);
      ui.hint('预演未写入文件、运行构建、创建提交、创建 Tag 或推送。正式模式会准备版本后运行全部测试。');
      return;
    }
    for (const directory of ['node_modules', 'companion/node_modules']) {
      try { await access(resolve(root, directory)); }
      catch { throw new Error(`缺少 ${directory}。请先在相应目录运行 npm ci；本工具不会自动安装依赖。`); }
    }
    if (JSON.stringify(await localState(guardedRun)) !== JSON.stringify(state)) throw new Error('准备前 Git 状态发生变化，请重新检查。');
    const draft = { head: state.head, version, files, progress: {}, pid: process.pid };
    await saveJournal(journalPath, draft, true);
    journal = draft;
    ensureActive();
    await applyFiles(root, files);
    ui.success('版本文件准备完成');
    ui.hint('检查 Extension 与 Companion；Build 包含正式隐私检查。');
    await runChecks(guardedRun, version);
    const prepared = await localState(guardedRun);
    async function verifyPrepared() {
      const now = await localState(guardedRun);
      if (now.branch !== 'main' || now.head !== state.head || now.status !== prepared.status) throw new Error('检查期间 Git 状态改变，禁止提交。');
      if (await guardedRun('git', ['diff', '--cached', '--name-only'])) throw new Error('暂存区出现其他文件，禁止提交。');
      const expected = files.map((file) => file.path);
      const changed = (await guardedRun('git', ['diff', '--name-only', '-z'])).split('\0').filter(Boolean);
      const untracked = (await guardedRun('git', ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      if ([...changed, ...untracked].some((path) => !expected.includes(path))) throw new Error('出现本次发布以外的文件变动，禁止提交。');
      for (const file of files) if (await readFile(resolve(root, file.path), 'utf8') !== file.after) throw new Error(`${file.path} 已改变，请重新检查。`);
      await checkRemote(guardedRun, version, state.head, releaseExists);
    }
    await verifyPrepared();
    ui.section('步骤 3 / 4 · 最终发布确认');
    ui.field('版本', ui.bold(`v${current} → v${version}`));
    ui.hint('更新说明');
    ui.list(notes.map((n) => `- ${n}`));
    ui.hint('已通过的检查');
    ui.list(['版本和远端状态', '版本声明一致性', '扩展与 Companion 的测试、代码、类型、构建及隐私检查', '文件格式检查']);
    ui.hint('接下来');
    ui.list(['保存版本更新并同步 main', '构建并校验 Windows 和 macOS 完整安装包', '公开发布两个 ZIP']);
    if (verbose) {
      ui.hint('本次变更文件');
      ui.list(files.map((f) => f.path));
      ui.field('Commit', `chore(release): v${version}`);
      ui.field('Tag', `v${version}`);
      ui.field('GitHub 仓库', repository);
    }
    await guardedRun('git', ['diff', '--stat'], true);
    if (await io.ask(`所有检查已通过，是否正式发布 v${version}？\n  请输入完整的「发布 v${version}」确认，其他输入均取消：`) !== `发布 v${version}`) throw new Error('用户取消发布。');
    await verifyPrepared();
    publishing = true;
    const progress = await publish(guardedRun, files, version, async (progress) => {
      journal.progress = progress;
      await saveJournal(journalPath, journal);
    });
    await unlink(journalPath);
    journal = null;
    ui.hint('等待 GitHub Actions 完成（最多 15 分钟；Ctrl+C 可停止等待）。');
    await showResult(run, version, progress.commit, { wait: true, active: ensureActive, verbose, display: liveProgress(process.stdout, undefined, !verbose) });
  } catch (error) {
    if (journal && !publishing) {
      try { await recoverPrepared(run, root, journal, true); await unlink(journalPath); ui.success('本次准备的版本改动已恢复。'); }
      catch (restoreError) { ui.error(`自动恢复停止：${restoreError.message}\n恢复记录：${journalPath}\n请检查后使用 npm run release -- --restore。`); }
    }
    if (publishing && journal) {
      const progress = error.progress ?? journal.progress;
      ui.section('发布已停止 · 需要核实');
      ui.error(error.message);
      ui.field('版本提交', progress.commit || '尚未确认');
      for (const [key, label] of [['main', 'main 推送'], ['tag', '本地 Tag'], ['tagPush', 'Tag 推送']]) {
        if (progress[key]) ui.success(`${label}已完成`);
        else ui.warning(`${label}尚未确认`);
      }
      ui.hint(`恢复记录：${journalPath}`);
      ui.hint('后续处理');
      ui.list([
        `先只读查询 git ls-remote origin refs/heads/main refs/tags/v${journal.version}，确认推送是否实际完成。`,
        '',
        `若 main 已推送且 Tag 缺失：检查 git rev-parse v${journal.version} 是否等于发布提交。`,
        '没有本地 Tag 时，手动在记录的提交上创建 Tag；核实后只推送该 Tag。',
        '',
        '不要重新创建发布提交，不要强制推送。记录核实处理完成后再手动删除。',
      ]);
    }
    throw error;
  } finally {
    io.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  const ui = terminalUI(process.stderr, (text) => console.error(text));
  if (/取消|中断/.test(error.message)) ui.warning(error.message);
  else ui.error(`停止：${error.message}`);
  process.exitCode = 1;
});
