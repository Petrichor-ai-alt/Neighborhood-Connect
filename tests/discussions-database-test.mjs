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
const migration = read('supabase/migrations/010-neighborhood-discussions.sql');
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
  "insert into household_members(user_id,household_id,display_name) values($1,$2,'Test Neighbor')",
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

const createThread = (
  area = n,
  id = null,
  revision = null,
  title = 'Tree recommendations',
  category = 'recommendations',
) =>
  db.query('select save_discussion_thread($1,$2,$3,$4,$5,$6) id', [
    area,
    id,
    title,
    'What grows well here?',
    category,
    revision,
  ]);
const reply = (thread, id = null, revision = null, body = 'Try an oak tree.') =>
  db.query('select save_discussion_reply($1,$2,$3,$4) id', [thread, id, body, revision]);
const thread = (await as(owner, () => createThread())).rows[0].id;
assert.equal(
  (await db.query('select author_name from discussion_threads where id=$1', [thread])).rows[0]
    .author_name,
  'Test Neighbor',
);
const response = (await as(resident, () => reply(thread))).rows[0].id;
assert.equal(
  (await db.query('select author_name from discussion_replies where id=$1', [response])).rows[0]
    .author_name,
  'Test',
);
assert.equal(
  (await db.query('select reply_count from discussion_threads where id=$1', [thread])).rows[0]
    .reply_count,
  1,
);
await as(resident, async () => {
  assert.equal((await db.query('select * from discussion_threads')).rows.length, 1);
  assert.equal((await db.query('select * from discussion_replies')).rows.length, 1);
  await assert.rejects(createThread(n, thread, 1, 'Forged edit'), /Only the author/);
  await assert.rejects(
    db.query("select moderate_discussion($1,'close',1)", [thread]),
    /Only an administrator/,
  );
  await assert.rejects(
    db.query("select moderate_discussion($1,'remove',1)", [thread]),
    /Only the author or an administrator/,
  );
  await assert.rejects(
    db.query("update discussion_threads set title='Bypass'"),
    /permission denied/,
  );
  await assert.rejects(db.query('delete from discussion_replies'), /permission denied/);
  await reply(thread, response, 1, 'Updated reply');
  await assert.rejects(reply(thread, response, 1, 'Stale reply'), /reply changed/);
});
for (const id of [outsider, pending])
  await as(id, async () => {
    assert.equal((await db.query('select * from discussion_threads')).rows.length, 0);
    assert.equal((await db.query('select * from discussion_replies')).rows.length, 0);
    await assert.rejects(createThread(), /Approved neighborhood/);
    await assert.rejects(reply(thread), /Approved neighborhood/);
    await assert.rejects(
      db.query("select moderate_discussion($1,'remove',1)", [thread]),
      /Approved neighborhood/,
    );
    await assert.rejects(
      db.query('select remove_discussion_reply($1,2)', [response]),
      /Approved neighborhood/,
    );
  });
await db.exec('set role anon');
await assert.rejects(db.query('select * from discussion_threads'), /permission denied/);
await assert.rejects(createThread(), /permission denied/);
await db.exec('reset role');
await as(owner, async () => {
  await assert.rejects(createThread(other), /Approved neighborhood/);
  await assert.rejects(createThread(n, thread, 99), /discussion changed/);
  await assert.rejects(createThread(n, null, null, '', 'general'), /check constraint/);
  await assert.rejects(createThread(n, null, null, 'Valid', 'fake'), /check constraint/);
  await assert.rejects(createThread(n, null, null, 'x'.repeat(121)), /check constraint/);
  await assert.rejects(reply(thread, null, null, 'x'.repeat(3001)), /check constraint/);
  await assert.rejects(reply(thread, response, 2, 'Forged reply'), /Only the author/);
  await createThread(n, thread, 1, 'Updated title');
});
await as(admin, () => db.query("select moderate_discussion($1,'close',2)", [thread]));
await as(owner, async () => {
  await assert.rejects(reply(thread), /closed/);
  await assert.rejects(createThread(n, thread, 3), /closed/);
});
await as(resident, () => db.query('select remove_discussion_reply($1,2)', [response]));
assert.equal(
  (await db.query('select reply_count from discussion_threads where id=$1', [thread])).rows[0]
    .reply_count,
  0,
);
await as(admin, () => db.query("select moderate_discussion($1,'reopen',3)", [thread]));
const response2 = (await as(owner, () => reply(thread))).rows[0].id;
await as(admin, async () => {
  await assert.rejects(
    createThread(n, thread, 4, 'Admin rewriting another author'),
    /Only the author/,
  );
  await assert.rejects(
    db.query("select moderate_discussion($1,'invalid',4)", [thread]),
    /Unknown discussion action/,
  );
});
await db.query('delete from auth.users where id=$1', [owner]);
assert.equal(
  (await db.query('select author_name from discussion_threads where id=$1', [thread])).rows[0]
    .author_name,
  'Former neighbor',
);
assert.equal(
  (await db.query('select author_name from discussion_replies where id=$1', [response2])).rows[0]
    .author_name,
  'Former neighbor',
);
await db.query('delete from memberships where user_id=$1', [resident]);
await as(resident, async () => {
  assert.equal((await db.query('select * from discussion_threads')).rows.length, 0);
  await assert.rejects(reply(thread), /Approved neighborhood/);
});
await as(admin, () => db.query("select moderate_discussion($1,'remove',5)", [thread]));
assert.equal(
  (await db.query('select * from discussion_replies where thread_id=$1', [thread])).rows.length,
  0,
);
await db.close();
console.log(
  'PASS: discussion migration/repeat, individual/household authors, private RLS, resident publishing, author editing, admin moderation, closed threads, revision guards, validation, reply counts, account deletion attribution and membership revocation.',
);
