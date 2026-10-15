import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { homedir } from 'node:os';
import { nativeHostTarget as target, nativeHostBinary as source } from './native-host-paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr ?? ''}`);
  return result.stdout;
}
const targetDirectory = resolve(root, 'companion/native-host/target');
run('cargo', ['build', '--release', '--locked', '--target', target,
  '--manifest-path', 'companion/native-host/Cargo.toml'], {
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: targetDirectory,
    RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} --remap-path-prefix=${homedir()}=/workspace` },
});
const suffix = target.includes('windows') ? '.exe' : '';
for (const destination of [
  `companion/src-tauri/binaries/windowstash-native-host-${target}${suffix}`,
  `companion/src-tauri/target/debug/windowstash-native-host${suffix}`,
  `companion/src-tauri/target/release/windowstash-native-host${suffix}`,
]) {
  const path = resolve(root, destination);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(source, path); await chmod(path, 0o755);
}
console.log('本机浏览器授权组件已准备');
