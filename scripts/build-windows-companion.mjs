import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Windows 安装包必须在 Windows x64 环境构建');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const installed = spawnSync('rustup', ['toolchain', 'list'], { encoding: 'utf8' });
if (installed.error) throw installed.error;
if (installed.status !== 0) throw new Error(installed.stderr);
const toolchain = installed.stdout
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/)[0])
  .find((name) => name.endsWith('-x86_64-pc-windows-msvc'));
if (!toolchain) {
  throw new Error('缺少 Rust MSVC x64 工具链，请先人工安装后重试');
}

const cli = resolve(root, 'companion/node_modules/@tauri-apps/cli/tauri.js');
const result = spawnSync(
  process.execPath,
  [cli, 'build', '--bundles', 'nsis', '--target', 'x86_64-pc-windows-msvc'],
  {
    cwd: resolve(root, 'companion'),
    env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
