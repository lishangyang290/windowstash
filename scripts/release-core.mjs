let marked;
try { ({ marked } = await import('marked')); }
catch { throw new Error('缺少发布工具的 Marked 依赖。请在项目根目录运行 npm ci，本工具不会自动安装依赖。'); }
import { readFile, writeFile, unlink, access, open, link, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const repository = 'lishangyang290/windowstash';
export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const notesHeading = /^(?:更新内容|更新说明|版本更新|主要变更|本次变更|完成内容|功能变更|开发总结|changes|release notes|what.s new)(?:如下)?\s*[:：]?$/i;
const versionLabel = /^(?:(?:当前|正式|目标|新|下个)?版本\s*[:：]|WindowStash\s+v?\d)/i;
// Match metadata labels and test-result lines, never keywords inside release prose.
const metadata = /^(?:(?:测试|检查|验证|提交|commit|main\s*HEAD|合并|分支|文件|工作区|构建|lint|typecheck|HEAD|push|tag|仓库|后续|下一步)(?:结果|报告|信息|状态|情况|记录|日志|列表)?\s*(?:[:：]|$)|\d+\s*(?:项通过|tests?\s+passed)(?:[.!。]|\s|$))/i;
const plain = (value) => value.replace(/\*\*|__|`/g, '').trim();

export function parseRelease(source) {
  const candidates = new Set();
  const explicit = new Set();
  const notes = [];
  let section = false;
  function lines(value, heading = false, extractVersion = true) {
    for (const raw of value.split(/\n|[,，;；]/)) {
      const line = plain(raw);
      if (notesHeading.test(line) && (heading || /[:：]$/.test(line))) section = true;
      else if (heading || (metadata.test(line) && /[:：]$/.test(line))) section = false;
      if (!extractVersion) continue;
      const transition = line.match(/(?:→|->|升级(?:至|到)|发布(?:为|至))\s*v?(\d+\.\d+\.\d+)/i);
      if (transition) explicit.add(transition[1]);
      if (!transition && !/当前|正式版本|旧版|原版本|previous|current/i.test(line)) {
        for (const match of line.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)) {
          if (/目标版本|新版本|下个版本|版本\s*[:：]/.test(line)) explicit.add(match[1]);
          else if (heading || /^WindowStash\s+v?\d/i.test(line)) candidates.add(match[1]);
        }
      }
    }
  }
  // Normalize the common non-Markdown bullet; leave every item's wording intact.
  for (const token of marked.lexer(source.replace(/^([ \t]*)•[ \t]+/gm, '$1- '))) {
    if (token.type === 'code' && /^(?:text|plaintext|md|markdown)?$/i.test(token.lang ?? '')
      && /(?:目标版本|版本\s*[:：]|WindowStash\s+v?\d)/.test(token.text)) {
      const parsed = parseRelease(token.text);
      for (const version of parsed.candidates) candidates.add(version);
      notes.push(...parsed.notes);
    }
    if (token.type === 'heading') lines(token.text, true);
    if (token.type === 'paragraph') {
      for (const line of token.text.split('\n')) {
        lines(line, false, !section || versionLabel.test(plain(line)));
        const text = plain(line);
        if (section && text && !notesHeading.test(text) && !metadata.test(text)
          && !versionLabel.test(text) && !/^[a-f0-9]{7,40}$/i.test(text)) notes.push(text);
      }
    }
    if (token.type === 'list') for (const item of token.items) {
      lines(item.text, false, versionLabel.test(plain(item.text)));
      const text = plain(item.text);
      if ((section || /^(新增|修复|优化|改进|支持|调整|移除|解决|增加)/.test(text))
        && !metadata.test(text) && !/^[\w@./\\-]+\.(?:tsx?|mjs|json|toml|lock)(?:\s|[：:]|$)/.test(text)) notes.push(text);
    }
  }
  const versions = [...(explicit.size ? explicit : candidates)];
  return { version: versions.length === 1 ? versions[0] : '', candidates: versions,
    notes, commit: source.match(/\b[a-f0-9]{40}\b/i)?.[0] ?? '',
    tests: source.split('\n').filter((line) => /测试|\d+\s*(项通过|tests? passed)/i.test(line)).join('\n') };
}

export function validateInput(version, current, notes) {
  if (!versionPattern.test(version)) throw new Error('目标版本必须为 X.Y.Z，不能含前导零或预发布后缀。');
  const a = version.split('.').map(BigInt), b = current.split('.').map(BigInt);
  const index = a.findIndex((value, i) => value !== b[i]);
  if (index < 0 || a[index] < b[index]) throw new Error('目标版本必须高于当前版本。');
  if (!notes.length || notes.some((note) => !note.trim())) throw new Error('更新说明不能为空，请补充。');
}

export function command(root, onProgress = () => {}) {
  return (program, args, live = false) => new Promise((resolveResult, reject) => {
    onProgress(`${program} ${args.join(' ')}`);
    const child = spawn(program, args, { cwd: root, shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', live ? 'inherit' : 'pipe', live ? 'inherit' : 'pipe'] });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let out = '', err = '';
    child.stdout?.on('data', (data) => { out += data; });
    child.stderr?.on('data', (data) => { err += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolveResult(out.trim()) : reject(new Error(`${program} ${args.join(' ')} 失败（${code}）：${err.trim()}`)));
  });
}

export async function localState(run) {
  return { branch: await run('git', ['branch', '--show-current']),
    head: await run('git', ['rev-parse', 'HEAD']), status: await run('git', ['status', '--porcelain', '--untracked-files=all']) };
}

export async function checkRemote(run, version, head, releaseExists) {
  for (const kind of ['get-url', '--push']) {
    const url = await run('git', kind === 'get-url' ? ['remote', 'get-url', '--all', 'origin'] : ['remote', 'get-url', '--push', '--all', 'origin']);
    if (!url.split('\n').every((address) => /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)lishangyang290\/windowstash(?:\.git)?\/?$/.test(address))) throw new Error('origin 读写地址必须指向 lishangyang290/windowstash，请手动检查远端。');
  }
  const remote = await run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
  if (remote.split(/\s/)[0] !== head) throw new Error('main 与远端不同，请先手动同步并检查。');
  if (await run('git', ['tag', '--list', `v${version}`])) throw new Error('本地已有同名 Tag，请选择新版本。');
  if (await run('git', ['ls-remote', 'origin', `refs/tags/v${version}`])) throw new Error('远端已有同名 Tag，请选择新版本。');
  if (await releaseExists(version)) throw new Error('GitHub 已有对应 Release，请选择新版本。');
}

export async function preflight(run, version, current, notes, releaseExists) {
  validateInput(version, current, notes);
  const state = await localState(run);
  if (state.branch !== 'main') throw new Error('必须位于 main。请先验收并合并开发分支，再手动切换到 main。');
  if (state.status) throw new Error('Git 工作区不干净或存在冲突。请先自行保存、提交或处理文件。');
  if (await run('git', ['ls-files', '-u'])) throw new Error('存在未解决的 Git 冲突。');
  if (await run('git', ['rev-parse', 'origin/main']) !== state.head) throw new Error('本地 main 与 origin/main 不一致，请先手动同步。');
  await checkRemote(run, version, state.head, releaseExists);
  return state;
}

const versionFiles = ['package.json', 'package-lock.json', 'companion/package.json', 'companion/package-lock.json', 'companion/src-tauri/tauri.conf.json', 'companion/src-tauri/Cargo.toml', 'companion/src-tauri/Cargo.lock', 'public/开始使用.html'];

export async function planFiles(root, version, notes) {
  if (!versionPattern.test(version)) throw new Error('目标版本必须为 X.Y.Z。');
  const files = [];
  async function edit(path, transform) {
    const before = await readFile(resolve(root, path), 'utf8');
    const after = transform(before);
    if (before !== after) files.push({ path, before, after });
  }
  for (const path of ['package.json', 'package-lock.json', 'companion/package.json', 'companion/package-lock.json', 'companion/src-tauri/tauri.conf.json']) {
    await edit(path, (source) => {
      const data = JSON.parse(source);
      data.version = version;
      if (path.endsWith('package-lock.json')) {
        if (!data.packages?.['']) throw new Error(`${path} 缺少根包声明。`);
        data.packages[''].version = version;
      }
      return JSON.stringify(data, null, 2) + '\n';
    });
  }
  await edit('companion/src-tauri/Cargo.toml', (source) => {
    let found = false;
    const result = source.replace(/(^\[package\]\s*\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m, (block) => block.replace(/^version\s*=\s*"[^"]+"/m, () => { found = true; return `version = "${version}"`; }));
    if (!found) throw new Error('Cargo.toml 缺少 package.version');
    return result;
  });
  await edit('companion/src-tauri/Cargo.lock', (source) => {
    let found = false;
    const result = source.split('[[package]]').map((block) => {
      if (!/^name\s*=\s*"windowstash-companion"$/m.test(block)) return block;
      return block.replace(/^version\s*=\s*"[^"]+"/m, () => { found = true; return `version = "${version}"`; });
    }).join('[[package]]');
    if (!found) throw new Error('Cargo.lock 缺少 Companion 包版本');
    return result;
  });
  await edit('public/开始使用.html', (source) => source.replace(/WindowStash-v\d+\.\d+\.\d+/g, `WindowStash-v${version}`));
  const path = `.github/release-notes/v${version}.md`;
  try { await access(resolve(root, path)); throw new Error('对应 Release Notes 已存在，不会覆盖，请先检查。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  files.push({ path, before: null, after: notes.map((note) => `- ${note}`).join('\n') + '\n' });
  return files;
}

export async function applyFiles(root, files) {
  for (const file of files) {
    if (file.before !== null && await readFile(resolve(root, file.path), 'utf8') !== file.before) throw new Error(`${file.path} 在准备期间已被修改，拒绝覆盖。`);
    await writeFile(resolve(root, file.path), file.after, { encoding: 'utf8', flag: file.before === null ? 'wx' : 'w' });
  }
}
export async function restoreFiles(root, files) {
  for (const file of files) {
    let current;
    try { current = await readFile(resolve(root, file.path), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; current = null; }
    if (current !== file.before && current !== file.after) throw new Error(`${file.path} 已被其他操作修改，拒绝覆盖；请按恢复记录手动处理。`);
  }
  for (const file of files) {
    if (file.before === null) await unlink(resolve(root, file.path)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    else await writeFile(resolve(root, file.path), file.before, 'utf8');
  }
}

// Link creates an exclusive complete record; rename atomically updates it after each step.
export async function saveJournal(path, journal, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(journal, null, 2) + '\n', 'utf8'); await file.sync(); }
    finally { await file.close(); }
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function recoverPrepared(run, root, journal, ownSession = false) {
  const note = `.github/release-notes/v${journal?.version}.md`;
  if (!/^[a-f0-9]{40}$/.test(journal?.head ?? '') || !versionPattern.test(journal?.version ?? '')
    || !Array.isArray(journal.files) || !journal.files.length
    || new Set(journal.files.map((file) => file.path)).size !== journal.files.length
    || journal.files.some((file) => ![...versionFiles, note].includes(file.path)
      || typeof file.after !== 'string' || (file.path === note ? file.before !== null : typeof file.before !== 'string'))) {
    throw new Error('恢复记录格式或文件范围无效，拒绝自动恢复，请人工检查。');
  }
  if (journal.pid && !(ownSession && journal.pid === process.pid)) {
    if (!Number.isInteger(journal.pid) || journal.pid <= 0) throw new Error('恢复记录中的进程信息无效。');
    try { process.kill(journal.pid, 0); throw new Error('发布进程仍在运行，禁止同时恢复；请先结束原会话。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (journal.progress?.commit || journal.progress?.main || journal.progress?.tag || journal.progress?.tagPush
    || journal.head !== await run('git', ['rev-parse', 'HEAD'])) {
    throw new Error('已产生提交或 HEAD 改变，请按恢复记录人工检查，不能自动回退。');
  }
  if (await run('git', ['branch', '--show-current']) !== 'main') throw new Error('分支已改变，拒绝自动恢复，请人工检查。');
  if (await run('git', ['diff', '--cached', '--name-only'])) throw new Error('暂存区不为空，请先人工检查暂存内容。');
  await restoreFiles(root, journal.files);
}

export async function runChecks(run, version) {
  await run(process.execPath, ['scripts/validate-release-version.mjs', version], true);
  await run(process.execPath, ['--test', 'scripts/release-tests.mjs'], true);
  for (const prefix of [[], ['--prefix', 'companion']]) {
    for (const script of ['test', 'lint', 'typecheck', 'build']) {
      // Each existing build already runs the privacy validator in its own environment.
      const scope = prefix.length ? [] : script === 'test' ? ['--', '--exclude', 'companion/**']
        : script === 'lint' ? ['--', '--ignore-pattern', 'companion/**'] : [];
      await run('npm', [...prefix, 'run', script, ...scope], true);
    }
  }
  await run('git', ['diff', '--check'], true);
}

export async function publish(run, files, version, checkpoint = async () => {}) {
  const progress = { commit: '', main: false, tag: false, tagPush: false };
  try {
    await run('git', ['add', '--', ...files.map((file) => file.path)]);
    const staged = (await run('git', ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean).sort();
    if (JSON.stringify(staged) !== JSON.stringify(files.map((file) => file.path).sort())) throw new Error('暂存文件与本次发布计划不一致，禁止提交。');
    await run('git', ['commit', '-m', `chore(release): v${version}`]);
    progress.commit = await run('git', ['rev-parse', 'HEAD']);
    await checkpoint(progress);
    const committedFiles = (await run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', progress.commit])).split('\0').filter(Boolean).sort();
    if (JSON.stringify(committedFiles) !== JSON.stringify(staged)) throw new Error('发布提交包含计划外的文件，请人工检查，未推送。');
    const committed = await localState(run);
    if (committed.status || committed.branch !== 'main' || committed.head !== progress.commit) throw new Error('提交后 Git 状态改变，请人工检查，未推送。');
    for (const file of files) {
      if (file.after !== undefined && await run('git', ['show', `${progress.commit}:${file.path}`]) !== file.after.trim()) throw new Error(`${file.path} 的提交内容与发布计划不一致，未推送。`);
    }
    await run('git', ['push', '--no-follow-tags', 'origin', `${progress.commit}:refs/heads/main`]);
    progress.main = true;
    await checkpoint(progress);
    await run('git', ['tag', `v${version}`, progress.commit]);
    progress.tag = true;
    await checkpoint(progress);
    await run('git', ['push', '--no-follow-tags', 'origin', `refs/tags/v${version}:refs/tags/v${version}`]);
    progress.tagPush = true;
    await checkpoint(progress);
    return progress;
  } catch (error) { error.progress = progress; throw error; }
}
