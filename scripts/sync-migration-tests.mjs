import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { checkMigration } from './verify-sync-migration.mjs';
const sql = readFileSync(new URL('../supabase/migrations/20261014_workspace_sync_v1.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
test('migration satisfies static security/compatibility contracts (not a database execution)', () => assert.equal(checkMigration(sql), true));
test('static checks reject missing guards, broken quotes, missing account ownership and destructive statements', () => {
  for (const bad of [sql.replace('before insert or update or delete', 'before insert'), sql.replace('w.user_id <> auth.uid()', 'true'), sql.replace('commit;', 'truncate public.workspaces; commit;'), `${sql}\n'`, sql.replace('enable row level security', 'disable row level security'), sql.replace("greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond')", 'now()'), sql.replace('create publication supabase_realtime;', ''), sql.replace('not pubinsert or not pubupdate', 'false'), sql.replace('create trigger workspaces_set_updated_at before update', 'create trigger wrong_trigger before update')]) {
    assert.throws(() => checkMigration(bad));
  }
});

test('fresh initialization includes the exact reviewed migration body in one transaction', () => {
  assert.equal(checkMigration(schema), true);
  const body = sql.slice(sql.indexOf('-- RLS does not protect TRUNCATE.'));
  assert.equal(schema.split('-- Workspace sync v1: identical to the incremental migration body.\n')[1], body);
  const top = schema.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, 'BODY');
  assert.equal((top.match(/\bbegin;/gi) ?? []).length, 1);
  assert.equal((top.match(/\bcommit;/gi) ?? []).length, 1);
  assert(!/\bnow\(\)\s*;/.test(top), 'initialization must not restore the old timestamp function');
  for (const index of ['workspaces_user_id_idx', 'workspaces_updated_at_idx', 'workspace_tombstones_user_idx']) assert(top.includes(`create index if not exists ${index}`));
  assert(schema.includes('references auth.users(id) on delete cascade'));
  assert(schema.includes('alter table public.workspaces enable row level security;'));
  assert(!/disable row level security/i.test(schema));
  assert.equal((schema.match(/on public\.workspaces for (select|insert|update|delete)\s+to authenticated/g) ?? []).length, 4);
  assert(schema.includes('grant select, insert, update, delete on table public.workspaces to authenticated'));
});

test('incremental upgrade never rebuilds or rewrites existing workspace rows', () => {
  const top = sql.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, 'BODY');
  assert(!/\b(?:create|drop|truncate)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?public\.workspaces\b/i.test(top));
  assert(!/\b(?:insert\s+into|update|delete\s+from)\s+public\.workspaces\b/i.test(top));
  assert(!/\b(?:drop\s+schema|alter\s+table\s+public\.workspaces\s+(?:drop|rename))\b/i.test(top));
  assert(top.includes("set local lock_timeout = '5s'"));
  assert(top.includes("set local statement_timeout = '30s'"));
});

test('SQL Editor inspection, backup export and failure-state queries are read-only', () => {
  for (const file of ['inspect_workspace_sync.sql', 'verify_workspace_sync_v1.sql', 'check_workspace_sync_state.sql', 'export_workspace_data.sql']) {
    const query = readFileSync(new URL(`../supabase/${file}`, import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
    assert(/^\s*begin read only;/i.test(query) && /commit;\s*$/i.test(query));
    const statements = query.replace(/'(?:[^']|'')*'/g, 'STRING');
    assert(!/\b(?:insert\s+into|update\s+public\.|delete\s+from|create|alter|drop|truncate)\b/i.test(statements));
  }
  const verify = readFileSync(new URL('../supabase/verify_workspace_sync_v1.sql', import.meta.url), 'utf8');
  assert(verify.includes('bool_and(pubinsert and pubupdate)'));
});

test('direct/PUBLIC revocation preserves CRUD and fails closed on inherited or SET ROLE privileges', () => {
  for (const bad of [
    sql.replace('from public, anon, authenticated', 'from anon, authenticated'),
    sql.replace('revoke truncate, references, trigger', 'revoke truncate'),
    sql.replace('grant select, insert, update, delete on table public.workspaces to authenticated;', ''),
    sql.replace("pg_has_role(client.oid, oid, 'USAGE')", 'false'),
    sql.replace("pg_has_role(client.oid, oid, 'SET')", 'false'),
    sql.replace("raise exception 'workspace_extra_privileges:", "raise notice 'workspace_extra_privileges:"),
  ]) assert.throws(() => checkMigration(bad));
  const verify = readFileSync(new URL('../supabase/verify_workspace_sync_v1.sql', import.meta.url), 'utf8');
  assert(verify.includes("pg_has_role(client.oid, reachable.oid, 'USAGE')"));
  assert(verify.includes("pg_has_role(client.oid, reachable.oid, 'SET')"));
  assert(verify.includes("has_table_privilege(reachable.oid, 'public.workspaces', 'TRUNCATE,REFERENCES,TRIGGER')"));
  assert(verify.includes("bool_and(has_table_privilege('authenticated', 'public.workspaces', privilege))"));
});

test('data export preserves every original field and refuses overwrites or destructive rollback', () => {
  const backup = readFileSync(new URL('../supabase/export_workspace_data.sql', import.meta.url), 'utf8');
  assert(backup.includes('(id,user_id,name,status,tabs,active_tab_index,content_hash,created_at,updated_at)'));
  assert(backup.includes('w.id, w.user_id, w.name, w.status, w.tabs::text, w.active_tab_index, w.content_hash, w.created_at, w.updated_at'));
  assert(backup.includes('%L::jsonb') && backup.includes('%L::timestamptz'));
  assert(backup.includes('IF EXISTS (SELECT 1 FROM public.workspaces) THEN RAISE EXCEPTION'));
  assert(backup.includes('restore_requires_empty_isolated_table'));
  assert(!/on conflict|truncate table|delete from|drop table/i.test(backup));
  const state = readFileSync(new URL('../supabase/check_workspace_sync_state.sql', import.meta.url), 'utf8');
  for (const source of [backup, state]) {
    assert(source.includes("md5(coalesce(string_agg(md5(to_jsonb(w)::text), '' order by w.id), ''))"));
    assert(source.includes('from auth.users u where u.id = w.user_id'));
  }
});
