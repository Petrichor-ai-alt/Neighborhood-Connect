import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
const root = new URL('../', import.meta.url);
await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;grant select,insert,delete on storage.objects to authenticated;`);
await db.exec(fs.readFileSync(new URL('supabase/setup.sql', root), 'utf8'));
const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`);
const [manager, adult, outsider, pending, wrong, otherAdult] = ids;
for (let i = 0; i < ids.length; i++)
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [
    ids[i],
    `person${i}@example.test`,
  ]);
const n = (await db.query("select id from neighborhoods where slug='burr-oaks'")).rows[0].id;
const h = (
  await db.query(
    "insert into households(neighborhood_id,address,display_name,latitude,longitude,residents) values($1,'1 Test Lane','Test home',41,-88,'Preserve this text') returning id",
    [n],
  )
).rows[0].id;
await db.query(
  "insert into memberships(user_id,neighborhood_id,household_id,role) values($1,$2,$3,'admin')",
  [manager, n, h],
);
const n2 = (
  await db.query(
    "insert into neighborhoods(slug,name) values('elsewhere','Elsewhere') returning id",
  )
).rows[0].id;
const h2 = (
  await db.query(
    "insert into households(neighborhood_id,address,display_name,latitude,longitude) values($1,'2 Test Lane','Other home',41,-88) returning id",
    [n2],
  )
).rows[0].id;
await db.query('insert into memberships(user_id,neighborhood_id,household_id) values($1,$2,$3)', [
  outsider,
  n2,
  h2,
]);
const migration = fs.readFileSync(
  new URL('supabase/migrations/002-household-members.sql', root),
  'utf8',
);
await db.exec(migration);
await db.exec(migration);
await db.exec(
  fs.readFileSync(new URL('supabase/migrations/003-household-photo-preference.sql', root), 'utf8'),
);
await db.exec(
  fs.readFileSync(new URL('supabase/migrations/003-household-photo-preference.sql', root), 'utf8'),
);
// Embedded PostgreSQL has no pg_cron extension. Exercise cache expiry/cleanup directly.
const geocodeMigration = fs
  .readFileSync(new URL('supabase/migrations/004-address-geocoding.sql', root), 'utf8')
  .replace(
    /-- BEGIN SUPABASE CRON[\s\S]*?-- END SUPABASE CRON/,
    '-- Cron schedule is tested in the deployed Supabase project.',
  );
await db.exec(geocodeMigration);
await db.exec(geocodeMigration);
assert.equal((await db.query('select count(*)::int c from household_members')).rows[0].c, 2);
assert.equal(
  (await db.query('select residents from households where id=$1', [h])).rows[0].residents,
  'Preserve this text',
);
async function as(user, sql, params = []) {
  await db.exec('set role authenticated');
  await db.query("select set_config('request.user_id',$1,false)", [user]);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role');
  }
}
async function denied(user, sql, params, message) {
  await assert.rejects(as(user, sql, params), message);
}
const p = (
  await as(manager, "select save_household_member($1,null,'Alex','','Books','','','') id", [h])
).rows[0].id;
assert.equal((await as(pending, 'select * from household_members')).rows.length, 0);
assert.equal(
  (await as(outsider, 'select * from household_members where household_id=$1', [h])).rows.length,
  0,
);
await denied(pending, "select save_household_member($1,null,'Bad')", [h], /manager/);
await denied(
  manager,
  'update household_members set user_id=$1 where id=$2',
  [adult, p],
  /permission denied/,
);
await denied(
  manager,
  "select manage_household_member(id,'demote') from household_members where user_id=$1",
  [manager],
  /at least one/,
);
const token = (
  await as(manager, 'select invite_household_member($1,$2) code', [p, 'person1@example.test'])
).rows[0].code;
await denied(wrong, 'select accept_household_invite($1)', [token], /verified email/);
await as(adult, 'select accept_household_invite($1)', [token]);
await denied(adult, 'select accept_household_invite($1)', [token], /invalid or expired/);
assert.equal(
  (await db.query('select count(*)::int c from household_members where household_id=$1', [h]))
    .rows[0].c,
  2,
);
assert.equal(
  (await db.query('select household_role from memberships where user_id=$1', [adult])).rows[0]
    .household_role,
  'member',
);
assert.equal(
  (await as(adult, "update households set photo_preference='none' where id=$1 returning id", [h]))
    .rows.length,
  0,
);
await as(manager, "update households set photo_preference='none' where id=$1", [h]);
await denied(
  manager,
  "update households set photo_preference='invalid' where id=$1",
  [h],
  /check constraint/,
);
await denied(adult, "select save_household_member($1,null,'Bad')", [h], /manager/);
assert.equal(
  (await as(adult, "update households set bio='Unauthorized' where id=$1 returning id", [h])).rows
    .length,
  0,
);
await denied(
  manager,
  "select save_household_member($1,$2,'Changed by manager')",
  [h, p],
  /cannot edit/,
);
await as(adult, "select save_household_member($1,$2,'Alex edited','','Walking')", [h, p]);
await denied(
  adult,
  "select save_household_member($1,$2,'Alex','','','','',$3)",
  [h, p, manager + '/fake.jpg'],
  /Invalid member photo/,
);
await denied(
  adult,
  "insert into storage.objects(bucket_id,name) values('household-photos',$1)",
  [h + '/fake.jpg'],
  /row-level security/,
);
await as(adult, "insert into storage.objects(bucket_id,name) values('member-photos',$1)", [
  p + '/fake.jpg',
]);
await denied(
  manager,
  "insert into storage.objects(bucket_id,name) values('member-photos',$1)",
  [p + '/manager.jpg'],
  /row-level security/,
);
await as(manager, "select manage_household_member($1,'promote')", [p]);
assert.equal((await as(adult, 'select household_login_roles($1)', [h])).rows.length, 2);
await as(manager, "select manage_household_member($1,'remove_login')", [p]);
assert.equal((await as(adult, 'select * from household_members')).rows.length, 0);
assert.equal(
  (await db.query('select user_id from household_members where id=$1', [p])).rows[0].user_id,
  null,
);
assert.equal(
  (await db.query('select display_name from household_members where id=$1', [p])).rows[0]
    .display_name,
  'Alex edited',
);
await as(manager, "select save_household_member($1,$2,'Alex managed again')", [h, p]);
const replaced = (
  await as(manager, 'select invite_household_member($1,$2) code', [p, 'person5@example.test'])
).rows[0].code;
const current = (
  await as(manager, 'select invite_household_member($1,$2) code', [p, 'person5@example.test'])
).rows[0].code;
await denied(otherAdult, 'select accept_household_invite($1)', [replaced], /invalid or expired/);
await as(manager, "select manage_household_member($1,'cancel_invite')", [p]);
await denied(otherAdult, 'select accept_household_invite($1)', [current], /invalid or expired/);
await db.query(
  "insert into access_requests(user_id,neighborhood_id,name,address) values($1,$2,'New resident','3 Test Lane')",
  [pending, n],
);
const r = (await db.query('select id from access_requests where user_id=$1', [pending])).rows[0].id;
await as(manager, 'select review_request($1,true,41::double precision,-88::double precision)', [r]);
assert.equal(
  (await db.query('select household_role from memberships where user_id=$1', [pending])).rows[0]
    .household_role,
  'manager',
);
console.log(
  'PASS: migration/repeat, preserved data, RLS isolation, manager/member editing, invitation claim/replay/replacement/cancel, private photos, login revocation, new approval.',
);
const lookupUser = '00000000-0000-0000-0000-000000000007';
await db.query(
  "insert into auth.users(id,email,email_confirmed_at) values($1,'lookup@example.test',now())",
  [lookupUser],
);
await db.query(
  "insert into access_requests(user_id,neighborhood_id,name,address) values($1,$2,'Lookup Person','4 Test Lane')",
  [lookupUser, n],
);
const lookupRequest = (
  await db.query('select id from access_requests where user_id=$1', [lookupUser])
).rows[0].id;
await as(
  lookupUser,
  'select save_request_geocode($1,41.75::double precision,-88.09::double precision)',
  [lookupRequest],
);
assert.equal((await as(lookupUser, 'select * from geocoded_locations')).rows.length, 1);
assert.equal((await as(wrong, 'select * from geocoded_locations')).rows.length, 0);
await denied(
  wrong,
  'select save_request_geocode($1,41::double precision,-88::double precision)',
  [lookupRequest],
  /Request owner/,
);
await denied(
  lookupUser,
  'select review_geocoded_request($1,true)',
  [lookupRequest],
  /Administrator/,
);
await denied(
  lookupUser,
  'update geocoded_locations set latitude=42 where request_id=$1',
  [lookupRequest],
  /permission denied/,
);
await as(manager, 'select review_geocoded_request($1,true)', [lookupRequest]);
const locatedHousehold = (
  await db.query('select household_id from memberships where user_id=$1', [lookupUser])
).rows[0].household_id;
const storedHousehold = (
  await db.query('select latitude,longitude,location_source from households where id=$1', [
    locatedHousehold,
  ])
).rows[0];
assert.equal(storedHousehold.latitude, null);
assert.equal(storedHousehold.longitude, null);
assert.equal(storedHousehold.location_source, 'google');
assert.equal(
  (
    await as(lookupUser, 'select * from geocoded_locations where household_id=$1', [
      locatedHousehold,
    ])
  ).rows.length,
  1,
);
assert.equal(
  (await as(outsider, 'select * from geocoded_locations where household_id=$1', [locatedHousehold]))
    .rows.length,
  0,
);
await denied(
  lookupUser,
  'select refresh_household_geocode($1,41::double precision,-88::double precision)',
  [locatedHousehold],
  /Administrator/,
);
await denied(
  manager,
  'select refresh_household_geocode($1,41::double precision,-88::double precision)',
  [h],
  /Manually verified/,
);
await db.query(
  "update geocoded_locations set geocoded_at=now()-interval '30 days',expires_at=now()-interval '1 day' where household_id=$1",
  [locatedHousehold],
);
assert.equal(
  (
    await as(lookupUser, 'select * from geocoded_locations where household_id=$1', [
      locatedHousehold,
    ])
  ).rows.length,
  0,
);
await db.query('select nc_private.purge_expired_geocodes()');
assert.equal(
  (await db.query('select * from geocoded_locations where household_id=$1', [locatedHousehold]))
    .rows.length,
  0,
);
await as(
  manager,
  'select refresh_household_geocode($1,41.751::double precision,-88.091::double precision)',
  [locatedHousehold],
);
assert.equal(
  (
    await as(lookupUser, 'select * from geocoded_locations where household_id=$1', [
      locatedHousehold,
    ])
  ).rows.length,
  1,
);
assert.equal(
  (await db.query('select location_source from households where id=$1', [h])).rows[0]
    .location_source,
  'manual',
);
console.log(
  'PASS: geocoding migration/repeat, pending candidate privacy, administrator-only approval/refresh, expiring cache, hidden expired coordinates, cleanup, renewal, preserved manual locations.',
);
// Test the actual background-refresh SQL against deterministic adapters, not live Google/Vault.
await db.exec(`create schema extensions;create schema vault;
create table vault.decrypted_secrets(name text primary key,decrypted_secret text);
create table extensions.test_http_fixture(status integer,body jsonb,throw_error boolean default false,calls integer default 0);
create function extensions.http_get(uri varchar,params jsonb) returns table(status integer,content varchar)
language plpgsql as $$begin
 if uri<>'https://maps.googleapis.com/maps/api/geocode/json' then raise exception 'Unexpected endpoint';end if;
 if params->>'key'<>'test-only-server-key' then raise exception 'Unexpected test key';end if;
 if (select throw_error from extensions.test_http_fixture) then raise exception 'test-only-server-key must never appear in refresh status';end if;
 update extensions.test_http_fixture set calls=calls+1;
 return query select f.status,f.body::text::varchar from extensions.test_http_fixture f;
end;$$;`);
const refreshMigration = fs
  .readFileSync(new URL('supabase/migrations/005-background-geocode-refresh.sql', root), 'utf8')
  .replace(
    /-- BEGIN SUPABASE EXTENSIONS[\s\S]*?-- END SUPABASE EXTENSIONS/,
    '-- HTTP/Vault adapters installed above.',
  )
  .replace(
    /-- BEGIN SUPABASE CRON[\s\S]*?-- END SUPABASE CRON/,
    '-- Call scheduled function directly in local tests.',
  );
await db.exec(refreshMigration);
await db.exec(refreshMigration);
await denied(manager, 'select nc_private.refresh_due_geocodes()', [], /permission denied/);
await assert.rejects(db.query('select nc_private.refresh_due_geocodes()'), /Supabase Vault/);
await db.query(
  "insert into vault.decrypted_secrets values('nc_google_geocoding_key','test-only-server-key')",
);
const googleResponse = {
  status: 'OK',
  results: [
    {
      address_components: [
        { types: ['street_number'] },
        { types: ['route'] },
        { types: ['country'], short_name: 'US' },
      ],
      geometry: { location_type: 'ROOFTOP', location: { lat: 41.751, lng: -88.091 } },
    },
  ],
};
await db.query('insert into extensions.test_http_fixture(status,body) values(200,$1)', [
  googleResponse,
]);
const runRefresh = async (force = false) =>
  (await db.query('select nc_private.refresh_due_geocodes($1,1) result', [force])).rows[0].result;
assert.equal((await runRefresh()).refreshed, 0);
assert.equal((await db.query('select calls from extensions.test_http_fixture')).rows[0].calls, 0);
await db.query(
  "update geocoded_locations set geocoded_at=now()-interval '25 days',expires_at=now()+interval '4 days' where household_id=$1",
  [locatedHousehold],
);
assert.equal((await runRefresh()).refreshed, 1);
assert.equal((await db.query('select calls from extensions.test_http_fixture')).rows[0].calls, 1);
assert.equal((await runRefresh()).refreshed, 0);
assert.equal((await runRefresh(true)).refreshed, 1);
const healthy = (
  await db.query('select * from geocoded_locations where household_id=$1', [locatedHousehold])
).rows[0];
assert.ok(
  new Date(healthy.expires_at).getTime() - new Date(healthy.geocoded_at).getTime() >= 28 * 86400000,
);
await db.query(
  "update geocoded_locations set geocoded_at=now()-interval '25 days',expires_at=now()+interval '4 days' where household_id=$1",
  [locatedHousehold],
);
await db.query(
  "update nc_private.geocode_refresh_state set next_attempt=now()-interval '1 hour' where household_id=$1",
  [locatedHousehold],
);
await db.query('update extensions.test_http_fixture set body=$1', [
  { status: 'REQUEST_DENIED', error_message: 'test-only-server-key must not be stored' },
]);
assert.equal((await runRefresh()).failed, 1);
assert.equal((await runRefresh()).failed, 0); // Retry backoff, not a flood of HTTP requests.
const failure = (
  await db.query('select * from nc_private.geocode_refresh_state where household_id=$1', [
    locatedHousehold,
  ])
).rows[0];
assert.equal(failure.error_code, 'REQUEST_DENIED');
assert.equal(JSON.stringify(failure).includes('test-only-server-key'), false);
const notExtended = (
  await db.query('select geocoded_at from geocoded_locations where household_id=$1', [
    locatedHousehold,
  ])
).rows[0];
assert.ok(new Date(notExtended.geocoded_at).getTime() < Date.now() - 24 * 86400000);
await db.query('update extensions.test_http_fixture set throw_error=true');
assert.equal((await runRefresh(true)).failed, 1);
assert.equal(
  (
    await db.query(
      'select error_code from nc_private.geocode_refresh_state where household_id=$1',
      [locatedHousehold],
    )
  ).rows[0].error_code,
  'NETWORK_OR_RESPONSE_ERROR',
);
await db.query('update extensions.test_http_fixture set throw_error=false,body=$1', [
  googleResponse,
]);
await db.query('delete from geocoded_locations where household_id=$1', [locatedHousehold]);
assert.equal((await runRefresh(true)).refreshed, 1); // Recover a missing cache from a new lookup.
assert.equal(
  (await db.query('select latitude from households where id=$1', [locatedHousehold])).rows[0]
    .latitude,
  null,
);
assert.equal(
  (await db.query('select latitude from households where id=$1', [h])).rows[0].latitude,
  41,
);
const ambiguous = {
  ...googleResponse,
  results: [googleResponse.results[0], googleResponse.results[0]],
};
assert.equal(
  (await db.query('select error_code from nc_private.parse_geocode_response($1)', [ambiguous]))
    .rows[0].error_code,
  'AMBIGUOUS_ADDRESS',
);
const partial = {
  ...googleResponse,
  results: [{ ...googleResponse.results[0], partial_match: true }],
};
assert.equal(
  (await db.query('select error_code from nc_private.parse_geocode_response($1)', [partial]))
    .rows[0].error_code,
  'PARTIAL_MATCH',
);
await assert.rejects(db.query('select nc_private.refresh_due_geocodes(false,26)'), /Batch size/);
console.log(
  'PASS: day-25 background refresh, fresh-cache skip, renewed expiry, retries/backoff, missing-cache recovery, restricted execution, response validation, preserved manual pins, secret-safe error records.',
);
await db.exec('create role service_role; create schema net;');
await db.exec(
  fs
    .readFileSync(new URL('supabase/migrations/006-oauth-geocode-refresh.sql', root), 'utf8')
    .replace(/-- BEGIN SUPABASE EXTENSIONS[\s\S]*?-- END SUPABASE EXTENSIONS/g, '')
    .replace(/-- BEGIN SUPABASE CRON[\s\S]*?-- END SUPABASE CRON/g, ''),
);
const claim = (await db.query('select * from claim_geocode_refresh(1,true)')).rows[0];
assert.ok(claim);
assert.equal(
  (await db.query('select * from claim_geocode_refresh(10,true)')).rows.some(
    (r) => r.household_id === claim.household_id,
  ),
  false,
);
assert.equal(
  (
    await db.query(
      'select finish_geocode_refresh($1,$2,(select latitude from geocoded_locations where household_id=$1),(select longitude from geocoded_locations where household_id=$1),NULL) result',
      [claim.household_id, claim.lease_token],
    )
  ).rows[0].result,
  true,
);
assert.equal(
  (
    await db.query(
      'select finish_geocode_refresh($1,$2,(select latitude from geocoded_locations where household_id=$1),(select longitude from geocoded_locations where household_id=$1),NULL) result',
      [claim.household_id, claim.lease_token],
    )
  ).rows[0].result,
  false,
);
await db.exec('set role authenticated');
await assert.rejects(db.query('select * from claim_geocode_refresh(1,true)'), /permission denied/);
await db.exec('reset role');
console.log(
  'PASS: OAuth worker leases, replay protection, successful cache renewal and resident RPC denial.',
);
await db.close();
