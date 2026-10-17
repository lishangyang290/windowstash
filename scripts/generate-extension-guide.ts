import { readFile, writeFile } from 'node:fs/promises';
import projectSettings from '../supabase/setup-guide.json';
import { resolve } from 'node:path';

export function externalizeGuideScript(html: string) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('开始使用.html 中未找到内联脚本');
  return {
    html: html.replace(match[0], '<script src="./开始使用.js"></script>'),
    script: `${match[1]!.trim()}\n`,
  };
}

export function applySetupResources(html: string, schema: string) {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = projectSettings.map(([name, value]) => `<tr><th>${escape(name!)}</th><td>${escape(value!)}</td></tr>`).join('');
  return html.replace(/(<code id="schema-code">)[\s\S]*?(<\/code>)/, (_, start, end) => `${start}${escape(schema.trimEnd())}${end}`)
    .replace(/(<table class="guide-table" id="project-settings"><tbody>)[\s\S]*?(<\/tbody>)/, (_, start, end) => `${start}${rows}${end}`);
}

export async function generateExtensionGuide(source: string, outputDir: string) {
  const schema = await readFile(resolve('supabase/schema.sql'), 'utf8');
  const guide = externalizeGuideScript(applySetupResources(await readFile(source, 'utf8'), schema));
  await Promise.all([
    writeFile(resolve(outputDir, '开始使用.html'), guide.html, 'utf8'),
    writeFile(resolve(outputDir, '开始使用.js'), guide.script, 'utf8'),
  ]);
}
