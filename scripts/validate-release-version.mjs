import { readFile } from 'node:fs/promises';

const expected = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expected ?? '')) {
  throw new Error('用法：node scripts/validate-release-version.mjs <X.Y.Z>');
}

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const rootPackage = await json('package.json');
const rootLock = await json('package-lock.json');
const companionPackage = await json('companion/package.json');
const companionLock = await json('companion/package-lock.json');
const tauri = await json('companion/src-tauri/tauri.conf.json');
const cargo = await readFile('companion/src-tauri/Cargo.toml', 'utf8');
const cargoLock = await readFile('companion/src-tauri/Cargo.lock', 'utf8');

const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLockVersion = cargoLock
  .split('[[package]]')
  .find((block) => /^name\s*=\s*"windowstash-companion"$/m.test(block))
  ?.match(/^version\s*=\s*"([^"]+)"$/m)?.[1];

const versions = {
  'package.json（Extension manifest 来源）': rootPackage.version,
  'package-lock.json': rootLock.version,
  'package-lock.json packages[""]': rootLock.packages?.['']?.version,
  'companion/package.json': companionPackage.version,
  'companion/package-lock.json': companionLock.version,
  'companion/package-lock.json packages[""]': companionLock.packages?.['']?.version,
  'companion/src-tauri/tauri.conf.json': tauri.version,
  'companion/src-tauri/Cargo.toml': cargoVersion,
  'companion/src-tauri/Cargo.lock': cargoLockVersion,
};

const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);
if (mismatches.length) {
  console.error(`Tag 版本 ${expected} 与正式版本声明不一致：`);
  for (const [source, version] of mismatches) console.error(`- ${source}: ${version ?? '缺失'}`);
  process.exit(1);
}

console.log(`版本检查通过：Tag 与全部正式版本声明均为 ${expected}`);
