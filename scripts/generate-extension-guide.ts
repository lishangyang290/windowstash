import { readFile, writeFile } from 'node:fs/promises';
import projectSettings from '../supabase/setup-guide.json';
import { resolve } from 'node:path';

export const upgradeSqlFiles = {
  'upgrade-inspect-code': 'supabase/inspect_workspace_sync.sql',
  'upgrade-backup-code': 'supabase/export_workspace_data.sql',
  'upgrade-migrate-code': 'supabase/migrations/20261014_workspace_sync_v1.sql',
  'upgrade-verify-code': 'supabase/verify_workspace_sync_v1.sql',
  'upgrade-state-code': 'supabase/check_workspace_sync_state.sql',
};

export function externalizeGuideScript(html: string) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('开始使用.html 中未找到内联脚本');
  return {
    html: html.replace(match[0], '<script src="./开始使用.js"></script>'),
    script: `${match[1]!.trim()}\n`,
  };
}

export function applySetupResources(html: string, schema: string, upgrades: Record<string, string> = {}) {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = projectSettings.map(([name, value]) => `<tr><th>${escape(name!)}</th><td>${escape(value!)}</td></tr>`).join('');
  for (const [id, sql] of Object.entries(upgrades)) {
    const block = new RegExp(`(<code id="${id}">)[\\s\\S]*?(<\\/code>)`);
    if (!block.test(html)) throw new Error(`教程缺少 SQL 区块：${id}`);
    html = html.replace(block, (_, start, end) => `${start}${escape(sql.trimEnd())}${end}`);
  }
  return html.replace(/(<code id="schema-code">)[\s\S]*?(<\/code>)/, (_, start, end) => `${start}${escape(schema.trimEnd())}${end}`)
    .replace(/(<table class="guide-table" id="project-settings"><tbody>)[\s\S]*?(<\/tbody>)/, (_, start, end) => `${start}${rows}${end}`);
}

export async function generateExtensionGuide(source: string, outputDir: string) {
  const schema = await readFile(resolve('supabase/schema.sql'), 'utf8');
  const upgrades = Object.fromEntries(await Promise.all(Object.entries(upgradeSqlFiles)
    .map(async ([id, file]) => [id, await readFile(resolve(file), 'utf8')])));
  const guide = externalizeGuideScript(applySetupResources(await readFile(source, 'utf8'), schema, upgrades));
  await Promise.all([
    writeFile(resolve(outputDir, '开始使用.html'), guide.html, 'utf8'),
    writeFile(resolve(outputDir, '开始使用.js'), guide.script, 'utf8'),
  ]);
}
