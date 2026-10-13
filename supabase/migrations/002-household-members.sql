-- Existing projects: run this complete file in Supabase SQL Editor.
-- Fresh projects: run setup.sql first, then this file. Safe to rerun.
begin;
alter table public.memberships add column if not exists household_role text not null default 'member'
 check(household_role in ('manager','member'));
create table if not exists public.household_members(
 id uuid primary key default gen_random_uuid(),
 household_id uuid not null references public.households(id) on delete cascade,
 user_id uuid references auth.users(id) on delete set null,
 display_name text not null check(length(trim(display_name)) between 1 and 100),
 bio text not null default '' check(length(bio)<=1500),
 interests text not null default '' check(length(interests)<=500),
 email text not null default '' check(length(email)<=200),
 phone text not null default '' check(length(phone)<=40),
 photo_path text not null default '' check(length(photo_path)<=300),
 created_at timestamptz not null default now(),
 unique(household_id,user_id)
);
create index if not exists household_members_household on public.household_members(household_id);
-- Pick one manager for households that have no manager yet. Preserve existing roles on reruns.
with first_accounts as (
 select distinct on (household_id) household_id,user_id from public.memberships
 order by household_id,(role='admin') desc,user_id
)
update public.memberships m set household_role='manager' from first_accounts f
where m.household_id=f.household_id and m.user_id=f.user_id
 and not exists(select 1 from public.memberships other where other.household_id=m.household_id and other.household_role='manager');
-- One real person per existing account. Do not guess people from the old residents text.
insert into public.household_members(household_id,user_id,display_name)
select m.household_id,m.user_id,coalesce(nullif(trim(r.name),''),nullif(trim(u.raw_user_meta_data->>'full_name'),''),'Household member')
from public.memberships m join auth.users u on u.id=m.user_id
left join public.access_requests r on r.user_id=m.user_id and r.neighborhood_id=m.neighborhood_id
on conflict(household_id,user_id) do nothing;

create or replace function nc_private.can_edit(h uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.household_id=h and m.household_role='manager'); $$;
create or replace function nc_private.photo_access(path text,writing boolean) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.households h join public.memberships m on m.neighborhood_id=h.neighborhood_id
 where m.user_id=auth.uid() and h.id::text=split_part(path,'/',1)
 and (not writing or (m.household_id=h.id and m.household_role='manager'))); $$;
create or replace function nc_private.can_edit_person(p uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.household_members person join public.households h on h.id=person.household_id
 where person.id=p and nc_private.is_member(h.neighborhood_id)
 and (person.user_id=auth.uid() or (person.user_id is null and nc_private.can_edit(person.household_id)))); $$;
create or replace function nc_private.person_photo_access(path text,writing boolean) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.household_members p join public.households h on h.id=p.household_id
 where p.id::text=split_part(path,'/',1) and nc_private.is_member(h.neighborhood_id)
 and (not writing or nc_private.can_edit_person(p.id))); $$;
revoke all on function nc_private.can_edit_person(uuid),nc_private.person_photo_access(text,boolean) from public,anon,authenticated;
grant execute on function nc_private.can_edit_person(uuid),nc_private.person_photo_access(text,boolean) to authenticated;
alter table public.household_members enable row level security;
revoke all on public.household_members from anon,authenticated;
grant select on public.household_members to authenticated;
drop policy if exists member_directory on public.household_members;
create policy member_directory on public.household_members for select to authenticated using(
 exists(select 1 from public.households h where h.id=household_id and nc_private.is_member(h.neighborhood_id)));

create table if not exists nc_private.member_invites(
 member_id uuid primary key references public.household_members(id) on delete cascade,
 token_hash bytea unique not null, target_email text not null,
 invited_by uuid not null references auth.users(id) on delete cascade,
 expires_at timestamptz not null
);
revoke all on nc_private.member_invites from public,anon,authenticated;
alter table nc_private.member_invites enable row level security;

create or replace function public.save_household_member(household uuid,person uuid,person_name text,
 person_bio text default '',person_interests text default '',contact_email text default '',contact_phone text default '',photo text default '')
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.household_members; result uuid;
begin
 perform 1 from public.households where id=household for update;
 if person is null then
  if not nc_private.can_edit(household) then raise exception 'Household manager access required'; end if;
  if photo<>'' then raise exception 'Save the profile before adding a photo'; end if;
  insert into public.household_members(household_id,display_name,bio,interests,email,phone)
  values(household,trim(person_name),person_bio,person_interests,trim(contact_email),trim(contact_phone)) returning id into result;
 else
  select * into p from public.household_members where id=person and household_id=household for update;
  if p.id is null or not nc_private.can_edit_person(p.id) then raise exception 'You cannot edit this member profile'; end if;
  if photo<>'' and (split_part(photo,'/',1)<>p.id::text or photo like '%..%') then raise exception 'Invalid member photo'; end if;
  update public.household_members set display_name=trim(person_name),bio=person_bio,interests=person_interests,
   email=trim(contact_email),phone=trim(contact_phone),photo_path=photo where id=p.id returning id into result;
 end if;
 return result;
end; $$;

create or replace function public.manage_household_member(person uuid,action text) returns void
language plpgsql security definer set search_path='' as $$
declare p public.household_members; m public.memberships; h uuid;
begin
 select household_id into h from public.household_members where id=person;
 perform 1 from public.households where id=h for update;
 select * into p from public.household_members where id=person for update;
 if p.id is null or not nc_private.can_edit(p.household_id) then raise exception 'Household manager access required'; end if;
 if action='delete' then
  if p.user_id is not null then raise exception 'Remove login access before deleting this profile'; end if;
  delete from public.household_members where id=p.id;
 elsif action='cancel_invite' then
  delete from nc_private.member_invites where member_id=p.id;
 elsif action in ('promote','demote','remove_login') then
  select * into m from public.memberships where household_id=p.household_id and user_id=p.user_id for update;
  if m.user_id is null then raise exception 'This member has no household login'; end if;
  if action in ('demote','remove_login') and m.household_role='manager' and
   (select count(*) from public.memberships where household_id=p.household_id and household_role='manager')<=1
   then raise exception 'A household must keep at least one manager'; end if;
  if action='remove_login' then
   if p.user_id=auth.uid() then raise exception 'Ask another manager to remove your login'; end if;
   if m.role='admin' then raise exception 'Neighborhood administrator access must be removed by a neighborhood administrator first'; end if;
   delete from public.memberships where household_id=p.household_id and user_id=p.user_id;
   update public.household_members set user_id=null where id=p.id;
   delete from nc_private.member_invites where member_id=p.id or invited_by=p.user_id;
  else
   update public.memberships set household_role=case when action='promote' then 'manager' else 'member' end
   where household_id=p.household_id and user_id=p.user_id;
  end if;
 else raise exception 'Unknown member action'; end if;
end; $$;

create or replace function public.invite_household_member(person uuid,login_email text) returns text
language plpgsql security definer set search_path='' as $$
declare p public.household_members; token text; h uuid;
begin
 select household_id into h from public.household_members where id=person;
 perform 1 from public.households where id=h for update;
 select * into p from public.household_members where id=person for update;
 if p.id is null or not nc_private.can_edit(p.household_id) then raise exception 'Household manager access required'; end if;
 if p.user_id is not null then raise exception 'This profile already has a login'; end if;
 if length(trim(login_email))>200 or trim(login_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid login email'; end if;
 token=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into nc_private.member_invites(member_id,token_hash,target_email,invited_by,expires_at)
 values(p.id,sha256(convert_to(token,'UTF8')),lower(trim(login_email)),auth.uid(),now()+interval '7 days')
 on conflict(member_id) do update set token_hash=excluded.token_hash,target_email=excluded.target_email,
 invited_by=excluded.invited_by,expires_at=excluded.expires_at;
 return token;
end; $$;

create or replace function public.accept_household_invite(invite_code text) returns uuid
language plpgsql security definer set search_path='' as $$
declare i nc_private.member_invites; p public.household_members; h public.households; login_email text; verified timestamptz; target uuid;
begin
 if auth.uid() is null then raise exception 'Sign in first'; end if;
 select member_id into target from nc_private.member_invites where token_hash=sha256(convert_to(invite_code,'UTF8'));
 select house.* into h from public.households house join public.household_members person on person.household_id=house.id where person.id=target;
 perform 1 from public.households where id=h.id for update;
 select * into i from nc_private.member_invites where member_id=target and token_hash=sha256(convert_to(invite_code,'UTF8')) for update;
 if i.member_id is null or i.expires_at<now() then raise exception 'Invitation is invalid or expired'; end if;
 if not exists(select 1 from public.memberships where user_id=i.invited_by and household_id=h.id and household_role='manager') then raise exception 'Invitation no longer authorized'; end if;
 select email,email_confirmed_at into login_email,verified from auth.users where id=auth.uid();
 if verified is null or lower(login_email)<>i.target_email then raise exception 'Sign in with the verified email this invitation was created for'; end if;
 select * into p from public.household_members where id=i.member_id for update;
 if p.user_id is not null then raise exception 'This profile already has a login'; end if;
 if exists(select 1 from public.memberships where user_id=auth.uid() and neighborhood_id=h.neighborhood_id) then raise exception 'You already belong to a household in this neighborhood'; end if;
 insert into public.memberships(user_id,neighborhood_id,household_id,household_role) values(auth.uid(),h.neighborhood_id,h.id,'member');
 update public.household_members set user_id=auth.uid() where id=p.id;
 update public.access_requests set status='approved' where user_id=auth.uid() and neighborhood_id=h.neighborhood_id;
 delete from nc_private.member_invites where member_id=p.id;
 return h.id;
end; $$;

create or replace function public.household_login_roles(household uuid)
returns table(member_id uuid,household_role text) language sql stable security definer set search_path='' as $$
 select p.id,m.household_role from public.household_members p join public.memberships m
 on m.household_id=p.household_id and m.user_id=p.user_id
 where p.household_id=household and (nc_private.can_edit(household) or p.user_id=auth.uid()); $$;
revoke all on function public.household_login_roles(uuid) from public,anon,authenticated;
grant execute on function public.household_login_roles(uuid) to authenticated;

-- Keep the existing approval signature; create a person with every approved login.
create or replace function public.review_request(request_id uuid,approve boolean,lat double precision default null,lng double precision default null,existing_household uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare r public.access_requests; h uuid; manager boolean;
begin
 select * into r from public.access_requests where id=request_id for update;
 if r.id is null or not nc_private.is_admin(r.neighborhood_id) then raise exception 'Administrator access required'; end if;
 if r.status<>'pending' then raise exception 'Request already reviewed'; end if;
 if approve then
  if existing_household is not null then
   select id into h from public.households where id=existing_household and neighborhood_id=r.neighborhood_id for update;
   if h is null then raise exception 'Household is not in this neighborhood'; end if;
  else
   if lat is null or lng is null then raise exception 'Verified map coordinates required'; end if;
   insert into public.households(neighborhood_id,address,display_name,latitude,longitude)
   values(r.neighborhood_id,r.address,left(r.name||' household',100),lat,lng) returning id into h;
  end if;
  manager=not exists(select 1 from public.memberships where household_id=h);
  insert into public.memberships(user_id,neighborhood_id,household_id,household_role) values(r.user_id,r.neighborhood_id,h,case when manager then 'manager' else 'member' end);
  insert into public.household_members(household_id,user_id,display_name) values(h,r.user_id,r.name);
 end if;
 update public.access_requests set status=case when approve then 'approved' else 'rejected' end where id=r.id;
end; $$;
revoke all on function public.save_household_member(uuid,uuid,text,text,text,text,text,text),public.manage_household_member(uuid,text),
 public.invite_household_member(uuid,text),public.accept_household_invite(text) from public,anon,authenticated;
grant execute on function public.save_household_member(uuid,uuid,text,text,text,text,text,text),public.manage_household_member(uuid,text),
 public.invite_household_member(uuid,text),public.accept_household_invite(text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('member-photos','member-photos',false,2097152,array['image/jpeg','image/png','image/webp']) on conflict(id) do nothing;
drop policy if exists nc_member_photo_read on storage.objects;
drop policy if exists nc_member_photo_upload on storage.objects;
drop policy if exists nc_member_photo_delete on storage.objects;
create policy nc_member_photo_read on storage.objects for select to authenticated using(bucket_id='member-photos' and nc_private.person_photo_access(name,false));
create policy nc_member_photo_upload on storage.objects for insert to authenticated with check(bucket_id='member-photos' and nc_private.person_photo_access(name,true));
create policy nc_member_photo_delete on storage.objects for delete to authenticated using(bucket_id='member-photos' and nc_private.person_photo_access(name,true));
notify pgrst,'reload schema';
commit;
