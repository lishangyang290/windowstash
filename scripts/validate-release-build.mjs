import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const targets = process.argv.slice(2).map((value) => resolve(value));
if (!targets.length) throw new Error('请提供正式构建产物目录');

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? files(child) : entry.isFile() ? [child] : [];
  }))).flat();
}

function envValues(source) {
  const values = [];
  for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']) {
    const match = source.match(new RegExp(`^${name}=(.*)$`, 'm'));
    const value = (match?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) values.push(value);
  }
  return values;
}

let privateValues = [process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY].filter(Boolean);
try {
  privateValues = [...privateValues, ...envValues(await readFile(resolve('.env'), 'utf8'))];
} catch {
  privateValues = [...privateValues];
}

const leaks = [];
for (const target of targets) {
  for (const file of await files(target)) {
    const text = (await readFile(file)).toString('utf8');
    const projectUrls = [...text.matchAll(/https:\/\/[\w-]+\.supabase\.co/g)].map(([url]) => url);
    if (privateValues.some((value) => text.includes(value))
      || projectUrls.some((url) => !url.includes('your-project'))
      || /sb_(?:publishable|secret)_[A-Za-z0-9_-]+/.test(text)) leaks.push(file);
  }
}

if (leaks.length) {
  console.error(`正式构建包含 Supabase 私人配置：\n${leaks.join('\n')}`);
  process.exit(1);
}
console.log('正式构建检查通过：未发现 Supabase 私人配置');
