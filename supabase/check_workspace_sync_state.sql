-- Read-only baseline BEFORE migration and persisted-state inspection AFTER success/failure.
-- If the same session is in an aborted transaction, issue ROLLBACK first, or open a new query session.
-- Compare count/digest with the saved baseline only while writers are paused.
-- Object presence alone cannot prove a migration committed successfully; also run inspect/verify SQL.
begin read only;
set local time zone 'UTC';
select count(*) as workspace_count,
  md5(coalesce(string_agg(md5(to_jsonb(w)::text), '' order by w.id), '')) as workspace_digest,
  count(*) filter (where not exists(select 1 from auth.users u where u.id = w.user_id)) as missing_auth_users,
  to_regclass('public.workspace_tombstones') is not null as tombstone_table_present,
  to_regprocedure('public.windowstash_guard_workspace()') is not null as guard_function_present,
  to_regprocedure('public.windowstash_snapshot_v1()') is not null as snapshot_rpc_present,
  to_regprocedure('public.windowstash_put_v1(jsonb,timestamptz)') is not null as put_rpc_present,
  to_regprocedure('public.windowstash_delete_v1(uuid)') is not null as delete_rpc_present,
  (select pg_get_functiondef(p.oid) from pg_catalog.pg_proc p
    where p.oid = to_regprocedure('public.set_updated_at()')) as timestamp_function,
  (select count(*) from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename in ('workspaces', 'workspace_tombstones')) as published_table_count
from public.workspaces w;
commit;
