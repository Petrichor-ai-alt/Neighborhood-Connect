import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.user_id',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text); alter table storage.objects enable row level security;`);
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
await db.exec(read('supabase/setup.sql'));
await db.exec(read('supabase/migrations/002-household-members.sql'));
const migration = read('supabase/migrations/008-community-calendar.sql');
await db.exec(migration);
await db.exec(migration);
const ids = Array.from({ length: 5 }, (_, i) => `80000000-0000-0000-0000-00000000000${i + 1}`);
const [owner, resident, admin, outsider, pending] = ids;
for (const id of ids)
  await db.query('insert into auth.users(id,email) values($1,$2)', [id, id + '@example.test']);
const n = (await db.query("select id from neighborhoods where slug='burr-oaks'")).rows[0].id;
const other = (
  await db.query("insert into neighborhoods(slug,name) values('other','Other') returning id")
).rows[0].id;
const h = (
  await db.query(
    "insert into households(neighborhood_id,address,display_name,latitude,longitude) values($1,'1 Test Ln','Test',41,-88) returning id",
    [n],
  )
).rows[0].id;
const h2 = (
  await db.query(
    "insert into households(neighborhood_id,address,display_name,latitude,longitude) values($1,'2 Test Ln','Other',41,-88) returning id",
    [other],
  )
).rows[0].id;
for (const id of [owner, resident, admin])
  await db.query(
    'insert into memberships(user_id,neighborhood_id,household_id,role) values($1,$2,$3,$4)',
    [id, n, h, id === admin ? 'admin' : 'resident'],
  );
await db.query('insert into memberships(user_id,neighborhood_id,household_id) values($1,$2,$3)', [
  outsider,
  other,
  h2,
]);
await db.query(
  "insert into household_members(user_id,household_id,display_name) values($1,$2,'Test Organizer')",
  [owner, h],
);
async function as(id, fn) {
  await db.query("select set_config('request.user_id',$1,false)", [id]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}
const save = (
  nid,
  id = null,
  revision = null,
  title = 'Neighborhood meetup',
  start = '2026-11-01T18:00:00-06:00',
  end = '2026-11-01T19:00:00-06:00',
) =>
  db.query('select save_neighborhood_event($1,$2,$3,$4,$5,$6,false,$7,$8,NULL,NULL) id', [
    nid,
    id,
    revision,
    title,
    'Bring a chair',
    'Local park',
    start,
    end,
  ]);
const event = (await as(owner, () => save(n))).rows[0].id;
assert.equal(
  (await db.query('select organizer_name from neighborhood_events where id=$1', [event])).rows[0]
    .organizer_name,
  'Test Organizer',
);
await as(resident, async () => {
  assert.equal((await db.query('select id from neighborhood_events')).rows.length, 1);
  await assert.rejects(save(n, event, 1, 'Forged edit'), /Only the organizer/);
  await assert.rejects(
    db.query('select cancel_neighborhood_event($1,1)', [event]),
    /Only the organizer/,
  );
  await assert.rejects(
    db.query("update neighborhood_events set title='Bypass'"),
    /permission denied/,
  );
  await assert.rejects(db.query('delete from neighborhood_events'), /permission denied/);
});
for (const user of [outsider, pending])
  await as(user, async () => {
    assert.equal((await db.query('select * from neighborhood_events')).rows.length, 0);
    await assert.rejects(save(n), /Approved neighborhood/);
    await assert.rejects(
      db.query('select cancel_neighborhood_event($1,1)', [event]),
      /Approved neighborhood/,
    );
  });
await db.exec('set role anon');
await assert.rejects(db.query('select * from neighborhood_events'), /permission denied/);
await db.exec('reset role');
await as(owner, async () => {
  await assert.rejects(save(other), /Approved neighborhood/);
  await assert.rejects(save(n, event, 99), /This event changed/);
  await assert.rejects(
    save(n, null, null, 'Invalid', '2026-11-01T19:00:00Z', '2026-11-01T18:00:00Z'),
    /check constraint/,
  );
  await save(n, event, 1, 'Updated meetup');
});
await as(admin, () => db.query('select cancel_neighborhood_event($1,2)', [event]));
assert.equal(
  (await db.query('select status from neighborhood_events where id=$1', [event])).rows[0].status,
  'cancelled',
);
await as(admin, () => save(n, event, 3, 'Admin correction'));
assert.equal(
  (await db.query('select status from neighborhood_events where id=$1', [event])).rows[0].status,
  'cancelled',
);
const allDay = (
  await as(owner, () =>
    db.query(
      "select save_neighborhood_event($1,NULL,NULL,'All day','','',true,NULL,NULL,'2026-12-24','2026-12-26') id",
      [n],
    ),
  )
).rows[0].id;
await as(resident, async () => {
  const result = await db.query(
    "select id from list_neighborhood_events($1,'2026-12-25T00:00:00-06:00','2026-12-26T00:00:00-06:00','2026-12-25','2026-12-26')",
    [n],
  );
  assert.deepEqual(
    result.rows.map((r) => r.id),
    [allDay],
  );
  assert.equal(
    (
      await db.query(
        "select * from list_neighborhood_events($1,'2026-12-26T00:00:00-06:00','2026-12-27T00:00:00-06:00','2026-12-26','2026-12-27')",
        [n],
      )
    ).rows.length,
    0,
  );
});
await db.query('delete from memberships where user_id=$1', [owner]);
await as(owner, () => assert.rejects(save(n, event, 4), /Approved neighborhood/));
await db.query('delete from auth.users where id=$1', [owner]);
assert.equal(
  (await db.query('select organizer_name from neighborhood_events where id=$1', [event])).rows[0]
    .organizer_name,
  'Former neighbor',
);
console.log(
  'PASS: calendar migration/repeat, resident publishing, private neighborhood RLS, owner/admin edits and cancellation, access revocation, stale-edit detection, duration validation and exclusive all-day overlap.',
);
await db.close();
