import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function generateReleaseGuide(extensionDir, destination) {
  const html = await readFile(join(extensionDir, '开始使用.html'), 'utf8');
  const script = await readFile(join(extensionDir, '开始使用.js'), 'utf8');
  const tag = '<script src="./开始使用.js"></script>';
  if (!html.includes(tag)) throw new Error('扩展教程缺少生成脚本，请先重新构建扩展');
  await writeFile(destination, html.replace(tag, () => `<script>${script}</script>`), 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateReleaseGuide(process.argv[2], process.argv[3]);
}
