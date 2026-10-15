-- READ ONLY. Copy the data_sql cell to a UTF-8 .sql file; do not send its private contents in chat.
-- Data-only supplement, NOT a full project backup. Auth users/schema/ACL must be preserved separately.
-- Restore ONLY into an isolated EMPTY compatible table with matching auth.users IDs after approval.
-- Plain INSERT deliberately refuses existing IDs. Never use as an in-place rollback or overwrite tool.
begin read only;
set local time zone 'UTC';
select count(*) as workspace_count,
  md5(coalesce(string_agg(md5(to_jsonb(w)::text), '' order by w.id), '')) as workspace_digest,
  count(*) filter (where not exists(select 1 from auth.users u where u.id = w.user_id)) as missing_auth_users,
  E'begin;\nDO $restore$ BEGIN IF EXISTS (SELECT 1 FROM public.workspaces) THEN RAISE EXCEPTION ''restore_requires_empty_isolated_table''; END IF; END $restore$;\n' || coalesce(string_agg(format(
    'INSERT INTO public.workspaces (id,user_id,name,status,tabs,active_tab_index,content_hash,created_at,updated_at) VALUES (%L::uuid,%L::uuid,%L,%L,%L::jsonb,%s,%L,%L::timestamptz,%L::timestamptz);',
    w.id, w.user_id, w.name, w.status, w.tabs::text, w.active_tab_index, w.content_hash, w.created_at, w.updated_at
  ), E'\n' order by w.id), '') || E'\ncommit;\n' as data_sql
from public.workspaces w;
commit;
