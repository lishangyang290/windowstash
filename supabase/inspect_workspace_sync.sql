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
select 'reachable_workspace_privileges', coalesce(jsonb_agg(jsonb_build_object(
  'client', client.rolname, 'reachable_role', reachable.rolname,
  'inherited', pg_catalog.pg_has_role(client.oid, reachable.oid, 'USAGE'),
  'set_role', pg_catalog.pg_has_role(client.oid, reachable.oid, 'SET'),
  'privilege', required.privilege,
  'granted', has_table_privilege(reachable.oid, to_regclass('public.workspaces'), required.privilege),
  'superuser', reachable.rolsuper, 'bypass_rls', reachable.rolbypassrls
)), '[]'::jsonb)
from pg_catalog.pg_roles client cross join pg_catalog.pg_roles reachable
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as required(privilege)
where client.rolname in ('anon', 'authenticated')
  and (pg_catalog.pg_has_role(client.oid, reachable.oid, 'USAGE') or pg_catalog.pg_has_role(client.oid, reachable.oid, 'SET'))
union all
select 'table_owners_and_acl', coalesce(jsonb_agg(jsonb_build_object(
  'table', c.relname, 'owner', pg_catalog.pg_get_userbyid(c.relowner), 'acl', c.relacl
)), '[]'::jsonb)
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('workspaces', 'workspace_tombstones')
union all
select 'schema_acl', coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'owner', pg_catalog.pg_get_userbyid(n.nspowner), 'acl', n.nspacl
)), '[]'::jsonb) from pg_catalog.pg_namespace n where n.nspname in ('public', 'auth')
union all
select 'client_role_memberships', coalesce(jsonb_agg(jsonb_build_object(
  'member', member.rolname, 'role', parent.rolname, 'membership', to_jsonb(m)
)), '[]'::jsonb)
from pg_catalog.pg_auth_members m
join pg_catalog.pg_roles member on member.oid = m.member
join pg_catalog.pg_roles parent on parent.oid = m.roleid
where exists (select 1 from pg_catalog.pg_roles client
  where client.rolname in ('anon', 'authenticated')
    and pg_catalog.pg_has_role(client.oid, member.oid, 'MEMBER'))
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
