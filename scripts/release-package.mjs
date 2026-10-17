import { copyFile, mkdir } from 'node:fs/promises';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';

export const releaseSqlFiles = {
  'schema.sql': 'supabase/schema.sql',
  '旧版本升级/20261014_workspace_sync_v1.sql': 'supabase/migrations/20261014_workspace_sync_v1.sql',
  '旧版本升级/verify_workspace_sync_v1.sql': 'supabase/verify_workspace_sync_v1.sql',
  '旧版本升级/inspect_workspace_sync.sql': 'supabase/inspect_workspace_sync.sql',
  '旧版本升级/export_workspace_data.sql': 'supabase/export_workspace_data.sql',
  '旧版本升级/check_workspace_sync_state.sql': 'supabase/check_workspace_sync_state.sql',
};

export const packageEntries = (version, windows) => ['Chrome Extension', 'README.txt', 'schema.sql', '旧版本升级',
  windows ? `WindowStash-v${version}-Windows-x64-setup.exe` : 'WindowStash Companion.app', '开始使用.html'].sort();

export async function copyReleaseSql(root) {
  for (const [destination, source] of Object.entries(releaseSqlFiles)) {
    await mkdir(dirname(join(root, destination)), { recursive: true });
    await copyFile(new URL(`../${source}`, import.meta.url), join(root, destination));
  }
}

export function validateReleaseSql(root) {
  const expected = Object.keys(releaseSqlFiles).filter(path => path.startsWith('旧版本升级/')).map(path => path.split('/')[1]).sort();
  if (JSON.stringify(readdirSync(join(root, '旧版本升级')).sort()) !== JSON.stringify(expected)) throw new Error('旧版本升级目录的 SQL 文件清单不正确');
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
