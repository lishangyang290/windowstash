import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

export const nativeHostTarget = process.env.TAURI_ENV_TARGET_TRIPLE
  || spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout?.match(/^host: (.+)$/m)?.[1];
if (!nativeHostTarget) throw new Error('无法识别 Rust 构建平台');
export const nativeHostBinary = fileURLToPath(new URL(
  `../companion/native-host/target/${nativeHostTarget}/release/windowstash-native-host${nativeHostTarget.includes('windows') ? '.exe' : ''}`,
  import.meta.url,
));
