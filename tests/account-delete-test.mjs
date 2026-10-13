import assert from 'node:assert/strict';
import { createDeleteHandler } from '../supabase/functions/delete-account/index.ts';
let calls = [],
  badPassword = false,
  blocked = false,
  deleteFailure = false;
const admin = {
  auth: {
    getUser: async () => ({ data: { user: { id: 'self', email: 'self@example.test' } } }),
    admin: {
      deleteUser: async (id) => {
        calls.push(['delete', id]);
        return deleteFailure ? { error: {} } : { error: null };
      },
    },
  },
  rpc: async (name, args) => {
    calls.push(['plan', args]);
    return blocked
      ? {
          error: {
            message:
              'Give another household login manager access in My Household before deleting your account.',
          },
        }
      : { data: [{ bucket: 'member-photos', name: 'self/photo.jpg' }] };
  },
  storage: {
    from: (bucket) => ({
      remove: async (names) => {
        calls.push(['remove', bucket, names]);
        return { error: null };
      },
    }),
  },
};
const verifier = {
  auth: {
    signOut: async () => ({ error: null }),
    signInWithPassword: async (args) => {
      calls.push(['password', args.email]);
      return badPassword ? { error: {} } : { data: { user: { id: 'self' } } };
    },
  },
};
let created = 0;
const handler = createDeleteHandler(
  (name) =>
    ({ SUPABASE_URL: 'test', SUPABASE_SERVICE_ROLE_KEY: 'server', SUPABASE_ANON_KEY: 'anon' })[
      name
    ],
  () => {
    created++;
    return created % 2 === 1 ? admin : verifier;
  },
);
const request = () =>
  new Request('https://test', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer verified-user-token',
      Origin: 'https://petrichor-ai-alt.github.io',
    },
    body: JSON.stringify({ password: 'test', confirmation: 'DELETE', user_id: 'other' }),
  });
assert.equal((await handler(new Request('https://test', { method: 'POST' }))).status, 401);
assert.equal(calls.length, 0);
assert.equal((await handler(request())).status, 200);
assert.deepEqual(
  calls.find((c) => c[0] === 'delete'),
  ['delete', 'self'],
);
calls = [];
badPassword = true;
assert.equal((await handler(request())).status, 403);
assert.equal(
  calls.some((c) => c[0] === 'plan' || c[0] === 'delete'),
  false,
);
badPassword = false;
blocked = true;
calls = [];
assert.equal((await handler(request())).status, 409);
assert.equal(
  calls.some((c) => c[0] === 'remove' || c[0] === 'delete'),
  false,
);
console.log(
  'PASS: deletion token/password checks, verified identity over caller input, manager handoff before photo removal and Auth deletion.',
);
