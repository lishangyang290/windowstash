import { terminalUI, presentedCommand } from './release-ui.mjs';
import { createInterface } from 'node:readline';
import { readFile, unlink, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseRelease, command, localState, preflight, checkRemote, planFiles, applyFiles, saveJournal, recoverPrepared, runChecks, publish, repository } from './release-core.mjs';

export function inputLines(input, output) {
  const ui = terminalUI(output);
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  rl.on('SIGINT', () => { rl.close(); process.emit('SIGINT'); });
  const iterator = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt) {
      output.write(ui.prompt(prompt));
      const next = await iterator.next();
      if (next.done) throw new Error('输入已结束，发布取消。');
      return next.value.trim();
    },
    async paste(prompt) {
      output.write(ui.paste(prompt));
      const lines = [];
      while (true) {
        const next = await iterator.next();
        if (next.done || next.value.trim() === ':cancel') throw new Error('发布取消。');
        if (next.value.trim() === ':end') return lines.join('\n');
        lines.push(next.value);
      }
    },
    close: () => rl.close(),
  };
}

export async function editRelease(io, current, log = console.log) {
  const ui = terminalUI(process.stdout, log);
  ui.section('步骤 1 / 4 · 粘贴发布信息');
  let result = parseRelease(await io.paste('请粘贴 ChatGPT 或 Codex 提供的完整发布信息。'));
  while (true) {
    if (!result.version && result.candidates.length > 1) {
      ui.warning('检测到多个目标版本，请选择。');
      ui.list(result.candidates.map((v, i) => `${i + 1}.  v${v}`));
      const choice = await io.ask('请选择编号，或直接输入目标 X.Y.Z：');
      result.version = result.candidates[Number(choice) - 1] ?? choice.replace(/^v/, '');
    }
    if (!result.version) result.version = (await io.ask('未识别目标版本，请输入 X.Y.Z：')).replace(/^v/, '');
    if (!result.notes.length) result.notes = manualNotes(await io.paste('未识别更新说明，请补充，每行一条。'));
    ui.section('识别结果');
    ui.field('当前版本', ui.bold(`v${current}`));
    ui.field('目标版本', ui.bold(`v${result.version}`));
    ui.hint('更新说明');
    ui.list(result.notes.map((n, i) => `${i + 1}.  ${n}`));
    ui.hint(`即将创建：v${result.version}`);
    if (result.commit || result.tests) ui.hint(`粘贴的提交与测试信息仅供参考：\n${[result.commit, result.tests].filter(Boolean).map((line) => `  ${line}`).join('\n')}`);
    ui.section('确认识别结果');
    ui.list(['1.  不需要，继续', '', '2.  修改目标版本', '3.  修改更新说明', '4.  重新粘贴', '', '5.  取消']);
    const choice = await io.ask('请选择 [1–5]：');
    if (choice === '1') return result;
    if (choice === '2') result.version = (await io.ask('目标版本 X.Y.Z：')).replace(/^v/, '');
    if (choice === '3') result.notes = manualNotes(await io.paste('请粘贴更新说明，每行一条。'));
    if (choice === '4') result = parseRelease(await io.paste('请重新粘贴完整发布信息。'));
    if (choice === '5') throw new Error('发布取消。');
  }
}
const manualNotes = (text) => text.split('\n').map((line) => line.trim().replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/, '')).filter(Boolean);

export async function releaseExists(version) {
  const response = await globalThis.fetch(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, {
    headers: { Accept: 'application/vnd.github+json' }, signal: globalThis.AbortSignal.timeout(20000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`无法确认 GitHub Release 是否存在（HTTP ${response.status}），请检查网络或 API 限额后重试。`);
  return true;
}

export async function showResult(run, version, commit, { wait = false, active = () => {} } = {}) {
  const ui = terminalUI();
  const releaseUrl = `https://github.com/${repository}/releases/tag/v${version}`;
  ui.section('步骤 4 / 4 · 发布结果');
  ui.field('版本提交', commit);
  ui.success('main 已推送');
  ui.success(`Tag v${version} 已推送`);
  ui.hint('远端页面');
  ui.field('GitHub Actions', `https://github.com/${repository}/actions/workflows/release.yml`);
  ui.field('GitHub Release', releaseUrl);
  try {
    await run('gh', ['auth', 'status']);
    // Match both workflow and exact release commit; unrelated runs must not count.
    let workflow, lastStatus = '';
    const deadline = Date.now() + 15 * 60 * 1000;
    while (true) {
      active();
      const runs = JSON.parse(await run('gh', ['run', 'list', '--repo', repository, '--workflow', 'release.yml', '--commit', commit, '--limit', '10', '--json', 'status,conclusion,url,headBranch']));
      workflow = runs.find((item) => item.headBranch === `v${version}`);
      const status = workflow?.status ?? 'waiting';
      if (status !== lastStatus) {
        if (!workflow) ui.pending('已推送 Tag，等待构建；尚未发现对应 Workflow。');
        else if (status === 'completed') ui.hint(`构建已结束：${workflow.url}`);
        else ui.pending(`正在构建（${status}）：${workflow.url}`);
        lastStatus = status;
      }
      if (status === 'completed') break;
      if (!wait || Date.now() >= deadline) { ui.warning('正在等待构建完成；Release 尚未确认，请查看上述页面。'); return; }
      await new Promise((done) => globalThis.setTimeout(done, 10000));
    }
    ui.field('Workflow', workflow.url);
    if (workflow.conclusion !== 'success') { ui.error(`构建未成功：${workflow.conclusion}。请打开 Workflow 查看日志。`); return; }
    const release = JSON.parse(await run('gh', ['release', 'view', `v${version}`, '--repo', repository, '--json', 'assets,url,isDraft,isPrerelease']));
    if (!release.isDraft && !release.isPrerelease && release.assets.some((asset) => asset.name === `WindowStash-v${version}-macOS.zip` && asset.size > 0)) ui.success(`发布成功，正式 ZIP 附件已生成：${release.url}`);
    else ui.warning('构建已结束，但正式 Release 或 ZIP 附件尚未确认，请查看页面。');
  } catch { ui.warning('无法自动确认远端状态。请安装并认证 gh，或打开上述页面；Tag 推送成功不代表 Release 已完成。'); }
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
    ui.list(['双击 WindowStash Release.command 或 npm run release', '', '--dry-run   只读预演', '--restore   恢复未提交的发布准备', '--verbose   显示底层命令及完整检查输出']);
    ui.hint('粘贴以 :end 结束，:cancel 取消。');
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
    ui.hint('准备创建新版本。');
    const { version, notes } = await editRelease(io, current);
    ui.section('步骤 2 / 4 · 检查发布条件');
    ui.pending('Git、版本、Tag 与 Release（只读远端查询）');
    const state = await preflight(guardedRun, version, current, notes, releaseExists);
    ui.success('Git、版本、Tag 与 Release 检查');
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
    ui.list(['Git / 远端 / Tag / Release', '九处版本一致性', '两端 Test / Lint / Typecheck / Build / 隐私检查', 'git diff --check']);
    ui.hint('本次变更文件');
    ui.list(files.map((f) => f.path));
    ui.hint('即将创建');
    ui.field('Commit', `chore(release): v${version}`);
    ui.field('Tag', `v${version}`);
    ui.field('GitHub 仓库', repository);
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
    await showResult(run, version, progress.commit, { wait: true, active: ensureActive });
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
