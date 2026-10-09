import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function externalizeGuideScript(html: string) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('开始使用.html 中未找到内联脚本');
  return {
    html: html.replace(match[0], '<script src="./开始使用.js"></script>'),
    script: `${match[1]!.trim()}\n`,
  };
}

export async function generateExtensionGuide(source: string, outputDir: string) {
  const guide = externalizeGuideScript(await readFile(source, 'utf8'));
  await Promise.all([
    writeFile(resolve(outputDir, '开始使用.html'), guide.html, 'utf8'),
    writeFile(resolve(outputDir, '开始使用.js'), guide.script, 'utf8'),
  ]);
}
