// Account deletion uses server credentials only after token and password verification.
export function createDeleteHandler(env, createClient) {
  return async (request) => {
    const origin = env('NC_SITE_ORIGIN') || 'https://petrichor-ai-alt.github.io';
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
    };
    const reply = (body, status = 200) => Response.json(body, { status, headers });
    if (request.headers.get('origin') && request.headers.get('origin') !== origin)
      return reply({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return reply({ error: 'Sign in again before deleting your account.' }, 401);
    try {
      const options = { auth: { persistSession: false, autoRefreshToken: false } };
      const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), options);
      const verified = await admin.auth.getUser(token);
      const user = verified.data?.user;
      if (verified.error || !user?.id || !user.email)
        return reply({ error: 'Sign in again before deleting your account.' }, 401);
      const input = await request.json();
      if (
        input.confirmation !== 'DELETE' ||
        typeof input.password !== 'string' ||
        !input.password ||
        input.password.length > 1024
      )
        return reply({ error: 'Enter your current password and type DELETE.' }, 400);
      // A separate client avoids replacing the server client's privileged session.
      const verifier = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), options);
      const password = await verifier.auth.signInWithPassword({
        email: user.email,
        password: input.password,
      });
      if (password.error || password.data?.user?.id !== user.id)
        return reply({ error: 'Your current password was not accepted.' }, 403);
      await verifier.auth.signOut({ scope: 'local' });
      const plan = await admin.rpc('account_deletion_plan', { account: user.id });
      if (plan.error) {
        // Only the two deliberate handoff messages are safe to show.
        const message = plan.error.message || '';
        const safe =
          message.startsWith('You are the last neighborhood administrator.') ||
          message.startsWith('Give another household login manager access');
        return reply(
          {
            error: safe
              ? message
              : 'Account deletion is not ready. Ask your administrator to check the account settings update.',
          },
          409,
        );
      }
      const buckets = new Map();
      for (const object of plan.data) {
        if (!['household-photos', 'member-photos'].includes(object.bucket))
          return reply(
            {
              error:
                'This account owns files outside the neighborhood app. Ask your administrator to handle deletion.',
            },
            409,
          );
        if (!buckets.has(object.bucket)) buckets.set(object.bucket, []);
        buckets.get(object.bucket).push(object.name);
      }
      for (const [bucket, names] of buckets) {
        for (let i = 0; i < names.length; i += 100) {
          const removed = await admin.storage.from(bucket).remove(names.slice(i, i + 100));
          if (removed.error)
            return reply(
              {
                error:
                  'Uploaded photos could not all be removed. Your login remains; retry deletion.',
              },
              503,
            );
        }
      }
      const deleted = await admin.auth.admin.deleteUser(user.id);
      if (deleted.error)
        return reply(
          {
            error:
              'Your login could not be deleted. Some uploaded photos may already have been removed. Reload settings and try again.',
          },
          409,
        );
      return reply({ deleted: true });
    } catch {
      return reply(
        {
          error:
            'Account deletion failed. Your login has not been confirmed deleted; reload settings before retrying.',
        },
        503,
      );
    }
  };
}
if (typeof Deno !== 'undefined') {
  const { createClient } = await import('npm:@supabase/supabase-js@2.49.1');
  Deno.serve(createDeleteHandler((name) => Deno.env.get(name), createClient));
}
