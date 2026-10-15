-- SQL Editor: select the intended project, then run this read-only inspection.
-- Contains no workspace titles, tabs, tokens or passwords. Safe before migration.
begin read only;
select 'settings' as section, jsonb_build_object(
  'server_version', current_setting('server_version'), 'wal_level', current_setting('wal_level')
) as details
union all
select 'tables', coalesce(jsonb_agg(jsonb_build_object(
  'name', c.relname, 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity
)), '[]'::jsonb)
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('workspaces', 'workspace_tombstones')
union all
select 'columns', coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
from information_schema.columns c where table_schema = 'public'
and table_name in ('workspaces', 'workspace_tombstones')
union all
select 'constraints', coalesce(jsonb_agg(jsonb_build_object(
  'table', c.conrelid::regclass::text, 'name', c.conname,
  'definition', pg_catalog.pg_get_constraintdef(c.oid)
)), '[]'::jsonb) from pg_catalog.pg_constraint c
where c.conrelid in (to_regclass('public.workspaces'), to_regclass('public.workspace_tombstones'))
union all
select 'policies', coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
from pg_catalog.pg_policies p where schemaname = 'public'
and tablename in ('workspaces', 'workspace_tombstones')
union all
select 'grants', coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
from information_schema.table_privileges g where table_schema = 'public'
and table_name in ('workspaces', 'workspace_tombstones')
union all
select 'functions', coalesce(jsonb_agg(jsonb_build_object(
  'signature', p.oid::regprocedure::text, 'owner', pg_catalog.pg_get_userbyid(p.proowner),
  'acl', p.proacl, 'definition', pg_catalog.pg_get_functiondef(p.oid)
)), '[]'::jsonb) from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('set_updated_at', 'windowstash_guard_workspace',
  'windowstash_snapshot_v1', 'windowstash_put_v1', 'windowstash_delete_v1')
union all
select 'triggers', coalesce(jsonb_agg(jsonb_build_object(
  'table', t.tgrelid::regclass::text, 'name', t.tgname,
  'enabled', t.tgenabled, 'definition', pg_catalog.pg_get_triggerdef(t.oid)
)), '[]'::jsonb) from pg_catalog.pg_trigger t
where not t.tgisinternal and (t.tgrelid = to_regclass('public.workspaces')
  or t.tgfoid = to_regprocedure('public.set_updated_at()'))
union all
select 'indexes', coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb)
from pg_catalog.pg_indexes i where schemaname = 'public'
and tablename in ('workspaces', 'workspace_tombstones')
union all
select 'publication', coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
from pg_catalog.pg_publication p where pubname = 'supabase_realtime'
union all
select 'published_tables', coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
from pg_catalog.pg_publication_tables p where pubname = 'supabase_realtime';
commit;
