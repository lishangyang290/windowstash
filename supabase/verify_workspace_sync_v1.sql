-- Read-only post-initialization/upgrade checks, including production after approval.
-- Every result must be true; this does not replace behavioral/API tests.
begin read only;
with functions as (
  select p.*, pg_catalog.pg_get_functiondef(p.oid) as definition
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.oid in (
    to_regprocedure('public.windowstash_snapshot_v1()'),
    to_regprocedure('public.windowstash_put_v1(jsonb,timestamptz)'),
    to_regprocedure('public.windowstash_delete_v1(uuid)'),
    to_regprocedure('public.windowstash_guard_workspace()'),
    to_regprocedure('public.set_updated_at()')
  )
)
select 'functions_and_security_mode' as check_name,
  count(*) = 5 and bool_and(prosecdef = (proname in (
    'windowstash_delete_v1', 'windowstash_guard_workspace'
  ))) as passed from functions
union all
select 'fixed_empty_search_path', count(*) = 5
  and bool_and(coalesce('search_path=""' = any(proconfig), false)) from functions
union all
select 'rpc_execute_permissions', count(*) = 3 and bool_and(
  has_function_privilege('authenticated', oid, 'EXECUTE')
  and not has_function_privilege('anon', oid, 'EXECUTE')
) from functions where proname in (
  'windowstash_snapshot_v1', 'windowstash_put_v1', 'windowstash_delete_v1'
)
union all
select 'trigger_function_not_client_callable', count(*) = 1 and bool_and(
  not has_function_privilege('authenticated', oid, 'EXECUTE')
  and not has_function_privilege('anon', oid, 'EXECUTE')
) from functions where proname = 'windowstash_guard_workspace'
union all
select 'monotonic_update_timestamp', count(*) = 1 and bool_and(
  definition like '%clock_timestamp()%'
  and definition like '%1 microsecond%'
) from functions where proname = 'set_updated_at'
union all
select 'rls_enabled', count(*) = 2 and bool_and(relrowsecurity)
from pg_catalog.pg_class
where oid in (to_regclass('public.workspaces'), to_regclass('public.workspace_tombstones'))
union all
select 'workspace_policies', count(*) = 4 and count(distinct cmd) = 4
  and bool_and(roles = array['authenticated']::name[]
    and coalesce(qual, with_check, '') like '%auth.uid()%'
    and coalesce(qual, with_check, '') like '%user_id%')
from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'workspaces'
union all
select 'tombstone_policy', count(*) = 1 and bool_and(cmd = 'SELECT'
  and roles = array['authenticated']::name[]
  and qual like '%auth.uid()%' and qual like '%user_id%')
from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'workspace_tombstones'
union all
select 'tombstone_table_permissions',
  has_table_privilege('authenticated', 'public.workspace_tombstones', 'SELECT')
  and not has_table_privilege('authenticated', 'public.workspace_tombstones', 'INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('anon', 'public.workspace_tombstones', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
union all
select 'enabled_guard_and_timestamp_triggers', count(*) = 2 and bool_and(
  t.tgenabled = 'O' and (
    (t.tgname = 'windowstash_workspace_guard' and t.tgtype = 31
      and t.tgfoid = to_regprocedure('public.windowstash_guard_workspace()'))
    or (t.tgname = 'workspaces_set_updated_at' and t.tgtype = 19
      and t.tgfoid = to_regprocedure('public.set_updated_at()'))
  ))
from pg_catalog.pg_trigger t where t.tgrelid = 'public.workspaces'::regclass and not t.tgisinternal
union all
select 'realtime_tables', count(*) = 2 from pg_catalog.pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public'
  and tablename in ('workspaces', 'workspace_tombstones')
union all
select 'realtime_events', count(*) = 1 and bool_and(pubinsert and pubupdate)
from pg_catalog.pg_publication where pubname = 'supabase_realtime'
union all
select 'required_indexes', count(*) = 5 from pg_catalog.pg_indexes
where schemaname = 'public' and indexname in (
  'workspaces_pkey', 'workspaces_user_id_idx', 'workspaces_updated_at_idx',
  'workspace_tombstones_pkey', 'workspace_tombstones_user_idx'
)
order by check_name;
commit;
