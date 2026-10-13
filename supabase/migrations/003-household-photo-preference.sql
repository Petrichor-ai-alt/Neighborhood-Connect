-- Run 002-household-members.sql first, then this file. Safe to repeat.
begin;
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='memberships' and column_name='household_role') then
  raise exception 'Run 002-household-members.sql before this photo upgrade';
 end if;
end $$;
alter table public.households add column if not exists photo_preference text not null default 'auto'
 check(photo_preference in ('auto','streetview','none'));
-- The existing manager-only household RLS policy also applies to this column.
grant update(photo_preference) on public.households to authenticated;
notify pgrst,'reload schema';
commit;
