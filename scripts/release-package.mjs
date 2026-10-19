import { copyFile, mkdir } from 'node:fs/promises';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';
import { macInstallerName } from './macos-package.mjs';

export const releaseSqlFiles = {
  '初始化数据库.sql': 'supabase/schema.sql',
};

export const packageEntries = (version, windows) => ['Chrome Extension', 'README.txt', '初始化数据库.sql',
  windows ? `WindowStash-v${version}-Windows-x64-setup.exe` : macInstallerName(version), '开始使用.html'].sort();

export async function copyReleaseSql(root) {
  for (const [destination, source] of Object.entries(releaseSqlFiles)) {
    await mkdir(dirname(join(root, destination)), { recursive: true });
    await copyFile(new URL(`../${source}`, import.meta.url), join(root, destination));
  }
}

export function validateReleaseSql(root) {
  const files = readdirSync(root).filter(name => name.endsWith('.sql') || name === '旧版本升级').sort();
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(releaseSqlFiles).sort())) throw new Error('SQL 文件清单不正确：完整 ZIP 只包含 初始化数据库.sql');
  for (const [destination, source] of Object.entries(releaseSqlFiles)) {
    const path = join(root, destination);
    if (!lstatSync(path).isFile() || !readFileSync(path).equals(readFileSync(new URL(`../${source}`, import.meta.url)))) {
      throw new Error(`SQL 文件与仓库源文件不一致：${destination}`);
    }
  }
}

export function validateGuidePackageTrees(html, version) {
  const trees = [...html.matchAll(/<pre class="package-tree">([\s\S]*?)<\/pre>/g)];
  if (trees.length !== 2) throw new Error('教程必须包含 Windows 和 macOS 两份目录示意');
  for (const [index, windows] of [true, false].entries()) {
    const [root, ...lines] = trees[index][1].trim().split(/\r?\n/);
    const entries = lines.map(line => line.replace(/^[├└]── /, '').replace(/\/$/, '')).sort();
    if (root !== `WindowStash-v${version}/` || JSON.stringify(entries) !== JSON.stringify(packageEntries(version, windows))) {
      throw new Error(`教程中的 ${windows ? 'Windows' : 'macOS'} 目录示意与发行包不一致`);
    }
  }
}
