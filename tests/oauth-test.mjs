import assert from 'node:assert/strict';
import {
  assertion,
  location,
  createHandler,
} from '../supabase/functions/refresh-geocodes/index.ts';
const keys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
const account = { private_key: pem, client_email: 'test@example.test', project_id: 'test-project' };
const jwt = await assertion(account, 1000);
const [header, body, signature] = jwt.split('.');
assert.equal(
  await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    keys.publicKey,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(`${header}.${body}`),
  ),
  true,
);
const claims = JSON.parse(Buffer.from(body, 'base64url'));
assert.equal(claims.exp, 4600);
assert.equal(claims.scope, 'https://www.googleapis.com/auth/maps-platform.geocode.address');
const result = {
  results: [
    {
      location: { latitude: 41, longitude: -88 },
      granularity: 'ROOFTOP',
      addressComponents: [
        { types: ['street_number'] },
        { types: ['route'] },
        { types: ['country'], shortText: 'US' },
      ],
    },
  ],
};
assert.deepEqual(location(result), { latitude: 41, longitude: -88 });
assert.throws(() => location({ results: [...result.results, ...result.results] }));
const vars = {
  NC_REFRESH_WORKER_TOKEN: 'test-secret',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-test-key',
};
let calls = [];
const handler = createHandler(
  (n) => vars[n],
  async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('claim_geocode_refresh'))
      return Response.json([
        { household_id: 'household', lease_token: 'lease', address: '1 Test Lane' },
      ]);
    if (url === 'https://oauth2.googleapis.com/token')
      return Response.json({ access_token: 'oauth-token' });
    if (url.startsWith('https://geocode.googleapis.com/')) {
      assert.equal(options.headers.Authorization, 'Bearer oauth-token');
      assert.equal(url.includes('key='), false);
      return Response.json(result);
    }
    return Response.json(true);
  },
);
assert.equal(
  (await handler(new Request('https://worker', { method: 'POST', body: '{}' }))).status,
  401,
);
assert.equal(calls.length, 0);
const response = await handler(
  new Request('https://worker', {
    method: 'POST',
    headers: { 'x-nc-refresh-token': 'test-secret' },
    body: '{"batch_size":1}',
  }),
);
assert.deepEqual(await response.json(), { attempted: 1, refreshed: 1, failed: 0 });
assert.equal(calls.length, 4);
console.log(
  'PASS: OAuth JWT signature/scope, worker authentication, v4 validation and bearer-only requests.',
);
