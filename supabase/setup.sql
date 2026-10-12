-- Run once in the Supabase SQL Editor on a new project.
begin;
create schema if not exists nc_private;
revoke all on schema nc_private from public;
grant usage on schema nc_private to authenticated;
create table public.neighborhoods(id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null);
create table public.households(
 id uuid primary key default gen_random_uuid(), neighborhood_id uuid not null references public.neighborhoods(id),
 address text not null check(length(address) between 5 and 250), display_name text not null check(length(display_name) between 1 and 100),
 residents text not null default '' check(length(residents)<=300), email text not null default '' check(length(email)<=200),
 phone text not null default '' check(length(phone)<=40), interests text not null default '' check(length(interests)<=500),
 bio text not null default '' check(length(bio)<=1500), latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180));
create unique index households_address on public.households(neighborhood_id, lower(trim(address)));
create table public.memberships(user_id uuid not null references auth.users(id) on delete cascade,
 neighborhood_id uuid not null references public.neighborhoods(id), household_id uuid not null references public.households(id),
 role text not null default 'resident' check(role in ('resident','admin')), primary key(user_id,neighborhood_id));
create table public.access_requests(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 neighborhood_id uuid not null references public.neighborhoods(id),name text not null check(length(name) between 1 and 100),
 address text not null check(length(address) between 5 and 250),status text not null default 'pending' check(status in ('pending','approved','rejected')),
 created_at timestamptz not null default now(),unique(user_id,neighborhood_id));
create index memberships_household on public.memberships(household_id);
create index requests_neighborhood on public.access_requests(neighborhood_id);
create function nc_private.is_member(n uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.neighborhood_id=n); $$;
create function nc_private.is_admin(n uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.neighborhood_id=n and m.role='admin'); $$;
create function nc_private.can_edit(h uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.household_id=h); $$;
create function nc_private.photo_access(path text,writing boolean) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.households h join public.memberships m on m.neighborhood_id=h.neighborhood_id
 where m.user_id=auth.uid() and h.id::text=split_part(path,'/',1) and (not writing or m.household_id=h.id)); $$;
revoke all on function nc_private.is_member(uuid), nc_private.is_admin(uuid), nc_private.can_edit(uuid), nc_private.photo_access(text,boolean) from public;
grant execute on function nc_private.is_member(uuid), nc_private.is_admin(uuid), nc_private.can_edit(uuid), nc_private.photo_access(text,boolean) to authenticated;
alter table public.neighborhoods enable row level security;
alter table public.households enable row level security;
alter table public.memberships enable row level security;
alter table public.access_requests enable row level security;
revoke all on public.neighborhoods,public.households,public.memberships,public.access_requests from anon,authenticated;
grant select on public.neighborhoods to anon,authenticated;
grant select on public.households,public.memberships,public.access_requests to authenticated;
grant update(display_name,residents,email,phone,interests,bio) on public.households to authenticated;
create policy neighborhood_branding on public.neighborhoods for select to anon,authenticated using(true);
create policy directory_approved_only on public.households for select to authenticated using(nc_private.is_member(neighborhood_id));
create policy edit_own_household on public.households for update to authenticated using(nc_private.can_edit(id)) with check(nc_private.can_edit(id));
create policy own_membership on public.memberships for select to authenticated using(user_id=auth.uid());
create policy own_or_admin_request on public.access_requests for select to authenticated using(user_id=auth.uid() or nc_private.is_admin(neighborhood_id));
create function public.request_access(neighborhood_slug text,resident_name text,household_address text) returns void
 language plpgsql security definer set search_path='' as $$
 declare n uuid;
 begin
 if auth.uid() is null then raise exception 'Sign in first'; end if;
 select id into n from public.neighborhoods where slug=neighborhood_slug;
 if n is null then raise exception 'Neighborhood not found'; end if;
 if nc_private.is_member(n) then raise exception 'Already approved'; end if;
 insert into public.access_requests(user_id,neighborhood_id,name,address) values(auth.uid(),n,trim(resident_name),trim(household_address));
 end; $$;
create function public.review_request(request_id uuid,approve boolean,lat double precision default null,lng double precision default null,existing_household uuid default null)
 returns void language plpgsql security definer set search_path='' as $$
 declare r public.access_requests; h uuid;
 begin
 select * into r from public.access_requests where id=request_id for update;
 if r.id is null or not nc_private.is_admin(r.neighborhood_id) then raise exception 'Administrator access required'; end if;
 if r.status<>'pending' then raise exception 'Request already reviewed'; end if;
 if approve then
  if existing_household is not null then
   select id into h from public.households where id=existing_household and neighborhood_id=r.neighborhood_id;
   if h is null then raise exception 'Household is not in this neighborhood'; end if;
  else
   if lat is null or lng is null then raise exception 'Verified map coordinates required'; end if;
   insert into public.households(neighborhood_id,address,display_name,latitude,longitude)
   values(r.neighborhood_id,r.address,r.name||' household',lat,lng) returning id into h;
  end if;
  insert into public.memberships(user_id,neighborhood_id,household_id) values(r.user_id,r.neighborhood_id,h);
 end if;
 update public.access_requests set status=case when approve then 'approved' else 'rejected' end where id=r.id;
 end; $$;
revoke all on function public.request_access(text,text,text),public.review_request(uuid,boolean,double precision,double precision,uuid) from public;
grant execute on function public.request_access(text,text,text),public.review_request(uuid,boolean,double precision,double precision,uuid) to authenticated;
insert into public.neighborhoods(slug,name) values('burr-oaks','Burr Oaks');
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('household-photos','household-photos',false,2097152,array['image/jpeg','image/png','image/webp']);
create policy nc_photo_read on storage.objects for select to authenticated using(bucket_id='household-photos' and nc_private.photo_access(name,false));
create policy nc_photo_upload on storage.objects for insert to authenticated with check(bucket_id='household-photos' and nc_private.photo_access(name,true));
create policy nc_photo_delete on storage.objects for delete to authenticated using(bucket_id='household-photos' and nc_private.photo_access(name,true));
commit;
