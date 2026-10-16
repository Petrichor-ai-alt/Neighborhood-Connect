// Server-only worker. No credentials belong in this file or the website.
const scope = 'https://www.googleapis.com/auth/maps-platform.geocode.address';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const encode = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
const json64 = (value) => encode(new TextEncoder().encode(JSON.stringify(value)));
export async function assertion(account, now = Math.floor(Date.now() / 1000)) {
  const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = `${json64({ alg: 'RS256', typ: 'JWT' })}.${json64({ iss: account.client_email, scope, aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  return `${message}.${encode(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(message))))}`;
}
export function location(payload) {
  if (!Array.isArray(payload.results) || payload.results.length !== 1)
    throw Error('INVALID_RESULT');
  const r = payload.results[0];
  const components = r.addressComponents || [];
  const lat = r.location?.latitude,
    lng = r.location?.longitude;
  if (
    r.partialMatch ||
    !['ROOFTOP', 'RANGE_INTERPOLATED'].includes(r.granularity) ||
    !components.some((c) => c.types?.includes('street_number')) ||
    !components.some((c) => c.types?.includes('route')) ||
    !components.some((c) => c.types?.includes('country') && c.shortText === 'US') ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    throw Error('INVALID_RESULT');
  return { latitude: lat, longitude: lng };
}
export function createHandler(env, fetcher = fetch) {
  return async (request) => {
    const reply = (body, status = 200) => Response.json(body, { status });
    const secret = env('NC_REFRESH_WORKER_TOKEN');
    // Compare fixed-length digests; reject before accessing Google or the database.
    const digest = async (s) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    const a = await digest(secret || ''),
      b = await digest(request.headers.get('x-nc-refresh-token') || '');
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    if (!secret || difference) return reply({ error: 'UNAUTHORIZED' }, 401);
    if (request.method !== 'POST') return reply({ error: 'METHOD' }, 405);
    try {
      const input = await request.json();
      const batch = input.batch_size ?? 10;
      if (
        !Number.isInteger(batch) ||
        batch < 1 ||
        batch > (input.force_refresh === true ? 100 : 10) ||
        (input.force_refresh !== undefined && typeof input.force_refresh !== 'boolean')
      )
        return reply({ error: 'INVALID_INPUT' }, 400);
      const rpc = async (name, body) => {
        const key = env('SUPABASE_SERVICE_ROLE_KEY');
        const res = await fetcher(`${env('SUPABASE_URL')}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw Error('DATABASE');
        return res.json();
      };
      const claims = await rpc('claim_geocode_refresh', {
        batch_size: batch,
        force_refresh: input.force_refresh === true,
      });
      if (!claims.length) return reply({ attempted: 0, refreshed: 0, failed: 0 });
      const account = JSON.parse(env('GOOGLE_SERVICE_ACCOUNT_JSON') || '{}');
      let token;
      try {
        const res = await fetcher(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: await assertion(account),
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw Error('OAUTH');
        token = (await res.json()).access_token;
        if (!token) throw Error('OAUTH');
      } catch {
        token = null;
      }
      let refreshed = 0,
        failed = 0;
      const processClaim = async (claim) => {
        let coords = { latitude: null, longitude: null },
          error = null;
        try {
          if (!token) throw Error('OAUTH');
          const res = await fetcher(
            `https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(claim.address)}?regionCode=US`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'X-Goog-User-Project': account.project_id,
              },
              signal: AbortSignal.timeout(8000),
            },
          );
          if (!res.ok) throw Error('GOOGLE_HTTP');
          coords = location(await res.json());
        } catch (e) {
          error = ['OAUTH', 'GOOGLE_HTTP', 'INVALID_RESULT'].includes(e.message)
            ? e.message
            : 'NETWORK';
        }
        const saved = await rpc('finish_geocode_refresh', {
          household: claim.household_id,
          lease: claim.lease_token,
          lat: coords.latitude,
          lng: coords.longitude,
          failure: error,
        });
        if (saved === true) refreshed++;
        else failed++;
      };
      // Bound parallel requests so a large manual batch fits the worker time budget.
      // Ordinary scheduled runs use at most five concurrent lookups.
      let next = 0;
      const concurrency = input.force_refresh === true ? 20 : 5;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, claims.length) }, async () => {
          while (next < claims.length) {
            const claim = claims[next++];
            await processClaim(claim);
          }
        }),
      );
      return reply({ attempted: claims.length, refreshed, failed });
    } catch {
      return reply({ error: 'WORKER_FAILED' }, 503);
    }
  };
}
if (typeof Deno !== 'undefined') Deno.serve(createHandler((name) => Deno.env.get(name)));
