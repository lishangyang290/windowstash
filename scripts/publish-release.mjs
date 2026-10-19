import { readFile, readdir, stat, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_REF_NAME: tag, GITHUB_SHA: sha, GITHUB_REPOSITORY: repository } = process.env;
if (event !== 'push' || ref !== `refs/tags/${tag}` || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '') || repository !== 'lishangyang290/windowstash' || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('只允许正式仓库的受控版本 Tag 发布');
function gh(args, allowMissing = false) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 120000, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404/.test(result.stderr)) return null;
    throw new Error(`GitHub 操作失败：${result.stderr}`);
  }
  return result.stdout;
}
const base = `WindowStash-${tag}`;
const names = [`${base}-macOS-arm64.zip`, `${base}-Windows-x64.zip`].sort();
const directory = resolve('release-assets');
if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names)) throw new Error('双平台附件缺失或包含额外文件，停止发布');
const files = names.map((name) => join(directory, name));
for (const path of files) if (!(await stat(path)).isFile() || !(await stat(path)).size) throw new Error('发布附件为空');
const notes = await readFile(`.github/release-notes/${tag}.md`, 'utf8');
if (!notes.trim()) throw new Error('更新说明为空');
const remoteTag = JSON.parse(gh(['api', `repos/${repository}/git/ref/tags/${tag}`]));
if (remoteTag.object.type !== 'commit' || remoteTag.object.sha !== sha) throw new Error('远端 Tag 已改变或不是受控发布提交');
if (gh(['api', `repos/${repository}/releases/tags/${tag}`], true) !== null) throw new Error('已有同名 Release，禁止覆盖或自动重试');
const temporary = await mkdtemp(join(tmpdir(), 'windowstash-publish-'));
const body = join(temporary, 'release-body.md');
const download = (name) => `https://github.com/${repository}/releases/download/${tag}/${name}`;
await writeFile(body, `# WindowStash ${tag}\n\n<details>\n<summary>版本更新说明</summary>\n\n${notes}\n</details>\n\n## 下载地址\n\n### macOS\n\n- [Apple Silicon arm64 完整安装包](${download(`${base}-macOS-arm64.zip`)})\n\n### Windows\n\n- [Windows x64 完整安装包（含 Chrome 扩展及教程）](${download(`${base}-Windows-x64.zip`)})\n\n首次安装请下载完整安装包，解压后打开「开始使用.html」。\n`, 'utf8');
// Any failed upload or audit leaves only a draft; never clobber existing assets.
gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--title', `WindowStash ${tag}`, '--notes-file', body]);
gh(['release', 'upload', tag, ...files, '--repo', repository]);
const release = JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'assets,isDraft,isPrerelease']));
if (!release.isDraft || release.isPrerelease || JSON.stringify(release.assets.map((asset) => asset.name).sort()) !== JSON.stringify(names)) throw new Error('草稿状态或附件集合不完整，禁止正式发布');
const downloaded = join(temporary, 'downloaded');
gh(['release', 'download', tag, '--repo', repository, '--dir', downloaded]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const name of names) {
  const local = await readFile(join(directory, name));
  if (release.assets.find((asset) => asset.name === name)?.size !== local.length || digest(local) !== digest(await readFile(join(downloaded, name)))) throw new Error(`附件上传校验失败：${name}，保持草稿`);
}
gh(['release', 'edit', tag, '--repo', repository, '--draft=false']);
console.log(`双平台附件已完整校验并正式发布：https://github.com/${repository}/releases/tag/${tag}`);
