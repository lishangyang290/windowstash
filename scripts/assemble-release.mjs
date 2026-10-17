import { cp, copyFile, mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateReleaseGuide } from './generate-release-guide.mjs';
import { copyReleaseSql } from './release-package.mjs';

const version = process.env.RELEASE_VERSION;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('无效发布版本');
const windows = process.platform === 'win32';
if (!windows && process.platform !== 'darwin') throw new Error('只能在对应平台打包');
const name = `WindowStash-v${version}`;
const output = resolve(process.env.RUNNER_TEMP, 'release-assets');
await mkdir(output, { recursive: true });
const staging = await mkdtemp(resolve(process.env.RUNNER_TEMP, 'windowstash-release-'));
const packageDir = join(staging, name);
await mkdir(packageDir);
await copyReleaseSql(packageDir);
await cp('.output/chrome-mv3', join(packageDir, 'Chrome Extension'), { recursive: true });
await generateReleaseGuide('.output/chrome-mv3', join(packageDir, '开始使用.html'));
await writeFile(join(packageDir, 'README.txt'), `WindowStash v${version}\n\n请先双击打开：\n开始使用.html\n\n按照教程完成 Chrome Extension、Supabase 和 WindowStash Companion 的安装。\n`, 'utf8');
if (windows) {
  const bundle = resolve('companion/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis');
  const installers = (await readdir(bundle)).filter((file) => file.endsWith('.exe'));
  if (installers.length !== 1) throw new Error('必须且只能生成一个 NSIS 安装程序');
  const installer = `${name}-Windows-x64-setup.exe`;
  await copyFile(join(bundle, installers[0]), join(packageDir, installer));
  await copyFile(join(bundle, installers[0]), join(output, installer));
} else {
  await cp('companion/src-tauri/target/release/bundle/macos/WindowStash Companion.app', join(packageDir, 'WindowStash Companion.app'), { recursive: true });
}
const zipPath = join(output, `${name}-${windows ? 'Windows-x64' : 'macOS-arm64'}.zip`);
if (windows) {
  // 7-Zip writes standard slash-separated ZIP members; Windows PowerShell does not.
  execFileSync('7z', ['a', '-tzip', zipPath, name], { cwd: staging, stdio: 'inherit' });
} else {
  execFileSync('ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noqtn', '--noacl', packageDir, zipPath]);
}
execFileSync(process.execPath, ['scripts/validate-release-artifact.mjs', packageDir, zipPath, version], { stdio: 'inherit' });
