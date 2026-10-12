-- After creating your account in the website and verifying your email,
-- replace all placeholders below. Run this in SQL Editor, not the website.
-- A verified address and its coordinates are required; do not use guessed home pins.
do $$
declare u uuid; n uuid; h uuid; verified_lat double precision := null; verified_lng double precision := null;
begin
 -- Replace null above with the verified latitude and longitude of your home.
 if verified_lat is null or verified_lng is null then raise exception 'Enter verified household coordinates before running'; end if;
 select id into u from auth.users where lower(email)=lower('YOUR_ACCOUNT_EMAIL');
 if u is null then raise exception 'Create your website account first'; end if;
 select id into n from public.neighborhoods where slug='burr-oaks';
 insert into public.households(neighborhood_id,address,display_name,latitude,longitude)
 values(n,'YOUR_FULL_ADDRESS','YOUR_HOUSEHOLD_NAME',verified_lat,verified_lng) returning id into h;
 insert into public.memberships(user_id,neighborhood_id,household_id,role) values(u,n,h,'admin');
 update public.access_requests set status='approved' where user_id=u and neighborhood_id=n;
end $$;
