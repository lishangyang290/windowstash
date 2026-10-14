// Static contract checks only. This does NOT compile or execute PL/pgSQL or verify RLS in PostgreSQL.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

export function checkMigration(sql) {
  const source = sql.replace(/--[^\n]*/g, '');
  const dollars = [...source.matchAll(/\$\$/g)];
  assert.equal(dollars.length % 2, 0, 'unclosed dollar-quoted function');
  const strings = source.replace(/\$\$[\s\S]*?\$\$/g, 'BODY').replace(/'(?:[^']|'')*'/g, 'STRING');
  assert(!strings.includes("'"), 'unclosed string');
  let depth = 0;
  for (const ch of strings) { if (ch === '(') depth++; if (ch === ')') depth--; assert(depth >= 0, 'unbalanced parentheses'); }
  assert.equal(depth, 0, 'unbalanced parentheses');
  assert(/^\s*begin;/i.test(source) && /commit;\s*$/i.test(source), 'migration must be transactional');
  assert(!/\b(?:truncate|drop\s+table|delete\s+from\s+public\.workspaces)\b/i.test(strings), 'no destructive top-level statements');
  assert(/create table if not exists public\.workspace_tombstones/i.test(source));
  assert(/alter table public\.workspace_tombstones enable row level security/i.test(source));
  assert(/grant select on public\.workspace_tombstones to authenticated/i.test(source));
  assert(!/grant[^;]*(?:insert|update|delete)[^;]*workspace_tombstones/i.test(source));
  assert(/before insert or update or delete on public\.workspaces/i.test(source), 'legacy writes must pass guard');
  assert(/using \(\(select auth\.uid\(\)\) = user_id\)/i.test(source));
  for (const name of ['windowstash_guard_workspace', 'windowstash_snapshot_v1', 'windowstash_put_v1', 'windowstash_delete_v1']) {
    assert(new RegExp(`create or replace function public\\.${name}\\(`).test(source), `missing ${name}`);
    assert(new RegExp(`revoke all on function[\\s\\S]*public\\.${name}\\(`).test(source), `missing execute revocation for ${name}`);
  }
  for (const match of source.matchAll(/create or replace function[\s\S]*?\$\$[\s\S]*?\$\$;/g)) {
    assert(/set search_path = ''/.test(match[0]), 'functions must pin search_path');
  }
  assert(/current_row\.updated_at <> expected_updated_at/.test(source), 'updates must compare server baseline');
  assert(/expected_updated_at is not null then raise exception/.test(source), 'missing synced rows must not be recreated');
  assert(/workspace_deleted/.test(source) && /pg_advisory_xact_lock/.test(source));
  assert(/t\.user_id <> auth\.uid\(\)/.test(source) && /w\.user_id <> auth\.uid\(\)/.test(source), 'definer delete must check both owners');
  return true;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkMigration(await readFile(new URL('../supabase/migrations/20261014_workspace_sync_v1.sql', import.meta.url), 'utf8'));
  console.log('迁移静态契约检查通过；未执行数据库迁移，SQL 编译、RLS、并发及 Realtime 集成验证待隔离数据库。');
}
