-- WindowStash v0.6.0: NEW projects only. Existing v0.5.0 databases use the incremental migration.
-- SQL Editor: run the entire file. Atomic, repeatable, and never clears workspaces.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  status text not null check (status in ('active', 'review', 'revision', 'archived')),
  tabs jsonb not null default '[]'::jsonb check (jsonb_typeof(tabs) = 'array'),
  active_tab_index integer not null default 0 check (active_tab_index >= 0),
  content_hash text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspaces_user_id_idx on public.workspaces(user_id);
create index if not exists workspaces_updated_at_idx on public.workspaces(updated_at desc);

alter table public.workspaces enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.workspaces to authenticated;

drop policy if exists "Users can read own workspaces" on public.workspaces;
create policy "Users can read own workspaces"
on public.workspaces for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create own workspaces" on public.workspaces;
create policy "Users can create own workspaces"
on public.workspaces for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own workspaces" on public.workspaces;
create policy "Users can update own workspaces"
on public.workspaces for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own workspaces" on public.workspaces;
create policy "Users can delete own workspaces"
on public.workspaces for delete
to authenticated
using ((select auth.uid()) = user_id);

-- Workspace sync v1: identical to the incremental migration body.
-- RLS does not protect TRUNCATE. Remove only unnecessary table privileges.
revoke truncate, references, trigger on table public.workspaces from public, anon, authenticated;
grant select, insert, update, delete on table public.workspaces to authenticated;
-- Do not silently alter shared roles or memberships: inherited privileges abort the transaction.
do $$
declare client record; reachable record;
begin
  for client in select oid, rolname from pg_catalog.pg_roles where rolname in ('anon', 'authenticated') loop
    for reachable in select oid, rolname from pg_catalog.pg_roles
      where pg_catalog.pg_has_role(client.oid, oid, 'USAGE') or pg_catalog.pg_has_role(client.oid, oid, 'SET') loop
      if pg_catalog.has_table_privilege(reachable.oid, 'public.workspaces', 'TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'workspace_extra_privileges: client=%, reachable_role=%; review grants or membership', client.rolname, reachable.rolname;
      end if;
    end loop;
  end loop;
end $$;
create table if not exists public.workspace_tombstones (
  workspace_id uuid primary key,
  user_id uuid not null,
  deleted_at timestamptz not null default clock_timestamp()
);
create index if not exists workspace_tombstones_user_idx on public.workspace_tombstones(user_id);
alter table public.workspace_tombstones enable row level security;
revoke all on public.workspace_tombstones from public, anon, authenticated;
grant select on public.workspace_tombstones to authenticated;
drop policy if exists "Read own deletion markers" on public.workspace_tombstones;
create policy "Read own deletion markers" on public.workspace_tombstones for select to authenticated
using ((select auth.uid()) = user_id);

-- Definer is needed to write markers while clients only have SELECT permission.
-- ID locks also serialize new RPC writes with old clients' direct writes.
create or replace function public.windowstash_guard_workspace()
returns trigger language plpgsql security definer set search_path = '' as $$
declare workspace uuid;
begin
  workspace := case when TG_OP = 'DELETE' then OLD.id else NEW.id end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(workspace::text, 0));
  if TG_OP = 'DELETE' then
    insert into public.workspace_tombstones(workspace_id, user_id) values (OLD.id, OLD.user_id)
      on conflict (workspace_id) do nothing;
    return OLD;
  end if;
  if exists (select 1 from public.workspace_tombstones where workspace_id = workspace) then
    raise exception using errcode = 'P0001', message = 'workspace_deleted';
  end if;
  if TG_OP = 'UPDATE' and (NEW.id <> OLD.id or NEW.user_id <> OLD.user_id) then
    raise exception using errcode = 'P0001', message = 'workspace_identity_immutable';
  end if;
  return NEW;
end $$;
revoke all on function public.windowstash_guard_workspace() from public, anon, authenticated;
drop trigger if exists windowstash_workspace_guard on public.workspaces;
create trigger windowstash_workspace_guard before insert or update or delete on public.workspaces
for each row execute function public.windowstash_guard_workspace();

-- A real wall-clock stamp is the compare-and-swap token, including multiple writes in one transaction.
create or replace function public.set_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  NEW.updated_at = greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  return NEW;
end $$;

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at before update on public.workspaces
for each row execute function public.set_updated_at();

create or replace function public.windowstash_snapshot_v1()
returns jsonb language sql stable security invoker set search_path = '' as $$
select jsonb_build_object('protocol', 1, 'user_id', auth.uid(),
  'records', coalesce((select jsonb_agg(to_jsonb(w)) from public.workspaces w where w.user_id = auth.uid()), '[]'::jsonb),
  'deleted', coalesce((select jsonb_agg(to_jsonb(t)) from public.workspace_tombstones t where t.user_id = auth.uid()), '[]'::jsonb))
$$;

create or replace function public.windowstash_put_v1(workspace jsonb, expected_updated_at timestamptz)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare current_row public.workspaces; result public.workspaces; target_id uuid := (workspace->>'id')::uuid;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'authorization_required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_id::text, 0));
  if exists(select 1 from public.workspace_tombstones where workspace_id = target_id) then
    raise exception using errcode = 'P0001', message = 'workspace_deleted';
  end if;
  select * into current_row from public.workspaces where id = target_id and user_id = auth.uid() for update;
  if found then
    -- Retry after a lost reply is idempotent only for the same complete content.
    if current_row.content_hash = workspace->>'content_hash'
      and current_row.name = workspace->>'name' and current_row.status = workspace->>'status'
      and current_row.tabs = workspace->'tabs' and current_row.active_tab_index = (workspace->>'active_tab_index')::integer then
      return to_jsonb(current_row);
    end if;
    if expected_updated_at is null or current_row.updated_at <> expected_updated_at then
      raise exception using errcode = 'P0001', message = 'workspace_conflict';
    end if;
    update public.workspaces set name = workspace->>'name', status = workspace->>'status', tabs = workspace->'tabs',
      active_tab_index = (workspace->>'active_tab_index')::integer, content_hash = workspace->>'content_hash'
      where id = target_id and user_id = auth.uid() returning * into result;
  else
    if expected_updated_at is not null then raise exception using errcode = 'P0001', message = 'workspace_missing'; end if;
    insert into public.workspaces(id,user_id,name,status,tabs,active_tab_index,content_hash,created_at)
      values(target_id,auth.uid(),workspace->>'name',workspace->>'status',workspace->'tabs',
        (workspace->>'active_tab_index')::integer,workspace->>'content_hash',(workspace->>'created_at')::timestamptz)
      returning * into result;
  end if;
  return to_jsonb(result);
end $$;

create or replace function public.windowstash_delete_v1(workspace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_id uuid := workspace_id;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'authorization_required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_id::text, 0));
  -- Definer must explicitly check ownership, including nonexistent/offline-created IDs.
  if exists(select 1 from public.workspaces w where w.id = target_id and w.user_id <> auth.uid())
    or exists(select 1 from public.workspace_tombstones t where t.workspace_id = target_id and t.user_id <> auth.uid()) then
    raise exception using errcode = '42501', message = 'wrong_account';
  end if;
  insert into public.workspace_tombstones(workspace_id,user_id) values(target_id,auth.uid()) on conflict on constraint workspace_tombstones_pkey do nothing;
  delete from public.workspaces where id = target_id and user_id = auth.uid();
end $$;

revoke all on function public.windowstash_snapshot_v1(), public.windowstash_put_v1(jsonb,timestamptz), public.windowstash_delete_v1(uuid) from public, anon;
grant execute on function public.windowstash_snapshot_v1(), public.windowstash_put_v1(jsonb,timestamptz), public.windowstash_delete_v1(uuid) to authenticated;

-- Publish INSERT/UPDATE signals, including tombstone INSERTs. Clients never trust DELETE payloads.
do $$
begin
  if not exists(select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if exists(select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime' and (not pubinsert or not pubupdate)) then
    raise exception 'supabase_realtime must publish INSERT and UPDATE; review publication settings before retrying';
  end if;
  if not exists(select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime' and puballtables) then
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='workspaces') then
      alter publication supabase_realtime add table public.workspaces;
    end if;
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='workspace_tombstones') then
      alter publication supabase_realtime add table public.workspace_tombstones;
    end if;
  end if;
end $$;
commit;
