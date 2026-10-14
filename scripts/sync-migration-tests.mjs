import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { checkMigration } from './verify-sync-migration.mjs';
const sql = readFileSync(new URL('../supabase/migrations/20261014_workspace_sync_v1.sql', import.meta.url), 'utf8');
test('migration satisfies static security/compatibility contracts (not a database execution)', () => assert.equal(checkMigration(sql), true));
test('static checks reject missing guards, broken quotes, missing account ownership and destructive statements', () => {
  for (const bad of [sql.replace('before insert or update or delete', 'before insert'), sql.replace('w.user_id <> auth.uid()', 'true'), sql.replace('commit;', 'truncate public.workspaces; commit;'), `${sql}\n'`, sql.replace('enable row level security', 'disable row level security')]) {
    assert.throws(() => checkMigration(bad));
  }
});
