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

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function public.set_updated_at();

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
