import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const [packageRootArgument, zipArgument, version] = process.argv.slice(2);
if (!packageRootArgument || !zipArgument || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
  throw new Error('用法：node scripts/validate-release-artifact.mjs <发布目录> <ZIP> <X.Y.Z>');
}

const packageName = `WindowStash-v${version}`;
const expectedTopLevel = ['Chrome Extension', 'README.txt', 'WindowStash Companion.app', '开始使用.html'];
const errors = [];

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function validatePaths(root, label) {
  const bannedParts = new Set(['.git', 'node_modules', 'target', 'deps', 'test', 'tests', '__tests__']);
  for (const path of walk(root)) {
    const member = relativePath(root, path);
    const parts = member.toLowerCase().split('/');
    const envFile = parts.some((part) => part === '.env' || part.startsWith('.env.'));
    if (envFile || parts.some((part) => bannedParts.has(part)) || member.toLowerCase().endsWith('.map')) {
      errors.push(`${label} 包含禁止路径：${member}`);
    }
    if (lstatSync(path).isSymbolicLink()) {
      const target = realpathSync(path);
      if (target !== root && !target.startsWith(`${root}${sep}`)) errors.push(`${label} 包含越界符号链接：${member}`);
    }
  }
}

const contentRules = [
  ['真实 Supabase Project URL', (text) => [...text.matchAll(/https:\/\/([a-z0-9-]+)\.supabase\.co/gi)]
    .some((match) => match[1].toLowerCase() !== 'your-project')],
  ['Supabase Publishable Key', (text) => /sb_publishable_[A-Za-z0-9_-]{16,}/.test(text)],
  ['Supabase Secret Key', (text) => /sb_secret_[A-Za-z0-9_-]{16,}/.test(text)],
  ['service_role 凭据值', (text) => /\bservice_role\b\s*["']?\s*[:=]\s*["'][A-Za-z0-9._-]{16,}/i.test(text)],
  ['JWT 凭据', (text) => /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)],
  ['序列化 Auth token/session', (text) => /["'](?:access_token|refresh_token|provider_token|provider_refresh_token)["']\s*:\s*["'][A-Za-z0-9._~-]{16,}/i.test(text)],
  ['macOS 用户绝对路径', (text) => /(?:file:\/\/\/)?\/Users\/[A-Za-z0-9._-]+\//i.test(text)],
  ['Windows 用户绝对路径', (text) => /[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+\\/i.test(text)],
  ['Linux 用户绝对路径', (text) => /\/home\/[A-Za-z0-9._-]+\//i.test(text)],
];

function validateContents(root, label) {
  for (const path of walk(root)) {
    if (!lstatSync(path).isFile()) continue;
    const text = readFileSync(path).toString('latin1');
    for (const [name, matches] of contentRules) {
      if (matches(text)) errors.push(`${label} 命中${name}：${relativePath(root, path)}`);
    }
  }
}

function validateStructure(root, label) {
  if (basename(root) !== packageName) errors.push(`${label} 根目录必须命名为 ${packageName}`);
  const actual = readdirSync(root).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedTopLevel)) {
    errors.push(`${label} 顶层内容不正确：${actual.join(', ')}`);
  }

  const manifestPath = join(root, 'Chrome Extension', 'manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== version) errors.push(`${label} Extension manifest 版本为 ${manifest.version}，预期 ${version}`);
  } catch {
    errors.push(`${label} 缺少有效的 Chrome Extension/manifest.json`);
  }

  const app = join(root, 'WindowStash Companion.app', 'Contents');
  try {
    readFileSync(join(app, 'Info.plist'));
    if (!walk(join(app, 'MacOS')).some((path) => lstatSync(path).isFile())) throw new Error();
    execFileSync('codesign', ['--verify', '--deep', '--strict', join(root, 'WindowStash Companion.app')], { stdio: 'pipe' });
  } catch {
    errors.push(`${label} 的 WindowStash Companion.app 不完整或签名无效`);
  }

  try {
    const guide = readFileSync(join(root, '开始使用.html'), 'utf8');
    if (!/<html[\s>]/i.test(guide)) throw new Error();
  } catch {
    errors.push(`${label} 缺少可独立发布的 开始使用.html`);
  }

  const expectedReadme = `WindowStash v${version}\n\n请先双击打开：\n开始使用.html\n\n按照教程完成 Chrome Extension、Supabase 和 WindowStash Companion 的安装。\n`;
  try {
    if (readFileSync(join(root, 'README.txt'), 'utf8') !== expectedReadme) throw new Error();
  } catch {
    errors.push(`${label} 的 README.txt 内容不正确`);
  }
}

function validateZipMembers(zipPath) {
  const archive = readFileSync(zipPath);
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('ZIP 缺少有效的中央目录');

  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const members = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    members.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const topLevel = new Set();
  for (const member of members) {
    if (member.startsWith('/') || member.includes('\\') || member.split('/').includes('..')) {
      errors.push(`ZIP 包含不安全成员路径：${member}`);
      continue;
    }
    const parts = member.replace(/\/$/, '').split('/');
    if (parts[0] !== packageName) errors.push(`ZIP 顶层不是 ${packageName}/：${member}`);
    if (parts[1]) topLevel.add(parts[1]);
  }
  if (JSON.stringify([...topLevel].sort()) !== JSON.stringify(expectedTopLevel)) {
    errors.push(`ZIP 内部顶层内容不正确：${[...topLevel].sort().join(', ')}`);
  }
}

const packageRoot = realpathSync(resolve(packageRootArgument));
const zipPath = realpathSync(resolve(zipArgument));
validateStructure(packageRoot, '最终发布目录');
validatePaths(packageRoot, '最终发布目录');
validateContents(packageRoot, '最终发布目录');
validateZipMembers(zipPath);

const extractionRoot = mkdtempSync(join(tmpdir(), 'windowstash-release-audit-'));
try {
  execFileSync('ditto', ['-x', '-k', zipPath, extractionRoot]);
  const extractedPackage = realpathSync(join(extractionRoot, packageName));
  validateStructure(extractedPackage, 'ZIP 解压内容');
  validatePaths(extractedPackage, 'ZIP 解压内容');
  validateContents(extractedPackage, 'ZIP 解压内容');
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}

if (errors.length) {
  console.error('最终 Release Artifact 验证失败：');
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`最终 Release Artifact 验证通过：${basename(zipPath)}`);
