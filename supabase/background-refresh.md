# Background geocoding with service-account OAuth

Migration 006 replaces the API-key implementation in 005. The website continues using its website-restricted Maps key. Do not delete that key. Background refresh uses Geocoding v4, a service-account credential stored only in Supabase, and short-lived address-geocoding OAuth tokens. No unrestricted Google API key is required.

## 1. Google Cloud

1. Select the **Neighborhood Directory** project at the top of Google Cloud Console.
2. Open **APIs & Services → Library**, search **Geocoding API**, and enable it. The project must have billing enabled.
3. Open **IAM & Admin → Service Accounts → Create service account**.
4. Name it `neighborhood-geocode-refresh` and click **Create and continue**.
5. Grant **Service Usage Consumer** on this project (for the quota project header). Do not grant Owner or Editor. Finish creation; no human users need access to this account.
6. Open the new service account → **Keys → Add key → Create new key → JSON → Create**. Save the downloaded file securely. Its private key belongs only in the server secret below. Do not upload it to GitHub or paste it into chat.
7. The old background geocoding API key can be deleted in **APIs & Services → Credentials**. Keep the website key with its website and API restrictions.

## 2. Supabase secrets

In your Supabase project open **Edge Functions → Secrets**.

- Add `GOOGLE_SERVICE_ACCOUNT_JSON`: paste the entire contents of the downloaded JSON file, including the braces. Keep the JSON's escaped newline characters intact.
- Generate a private scheduler token in **SQL Editor**:

```sql
select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') as worker_token;
```

- Add `NC_REFRESH_WORKER_TOKEN` in Edge Function Secrets using that generated value.
- Open **Integrations → Vault** (or search for Vault in the dashboard). Add:
  - `nc_refresh_worker_token`: exactly the same generated token.
  - `nc_refresh_worker_url`: `https://xfkfkxhcgcbufwsobjsf.supabase.co/functions/v1/refresh-geocodes`.
- If those Vault names already exist, edit them instead of creating duplicates. Delete the obsolete Vault secret `nc_google_geocoding_key` after switching.

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions automatically. Never put either the service-role key or these new secrets in `config.js`.

## 3. Deploy the function

1. Open **Edge Functions**, create a function using the dashboard editor, and name it **`refresh-geocodes`**.
2. Replace its `index.ts` with the complete contents of [`functions/refresh-geocodes/index.ts`](functions/refresh-geocodes/index.ts).
3. Deploy it.
4. In the function's settings, disable **Verify JWT** for this function only. The code checks the private `x-nc-refresh-token` header before any database or Google access. Leave JWT verification enabled for other functions.

CLI alternative from the repository root:

```sh
supabase functions deploy refresh-geocodes --project-ref xfkfkxhcgcbufwsobjsf --no-verify-jwt
```

## 4. Switch the schedule

In **SQL Editor**, paste and run the complete contents of [`migrations/006-oauth-geocode-refresh.sql`](migrations/006-oauth-geocode-refresh.sql). It requires migrations 004 and 005, which you already ran. Do not rerun `setup.sql`.

The hourly job refreshes Google locations at day 25. Successful lookups receive a new 29-day expiry. Failed lookups retain their original expiry and retry after one to six hours. Manual locations are untouched. The hourly expired-cache cleanup remains enabled. Function deployment and secrets must be completed before running the new job.

## 5. Test and inspect

Force a single-household refresh from SQL Editor:

```sql
select
  nc_private.enqueue_geocode_refresh (true, 1);
```

The result is an asynchronous HTTP request ID, not proof of a successful Google lookup. After the request completes, inspect:

```sql
select
  status_code,
  timed_out
from
  net._http_response
order by
  created desc
limit
  5;

select
  household_id,
  last_attempt,
  last_success,
  error_code,
  failures,
  next_attempt
from
  nc_private.geocode_refresh_state
order by
  last_attempt desc;

select
  household_id,
  geocoded_at,
  expires_at
from
  public.geocoded_locations
where
  household_id is not null;

select
  jobid,
  jobname,
  schedule,
  active
from
  cron.job
where
  jobname in (
    'nc-refresh-geocodes',
    'nc-purge-expired-geocodes'
  );
```

A successful worker response reports `attempted`, `refreshed`, and `failed`. If there are no Google-managed households, all counts are zero; manually positioned households deliberately stay unchanged. Test an approved Google-managed household to verify a real lookup. `OAUTH` indicates service-account/secret configuration trouble; `GOOGLE_HTTP` indicates a Google API, billing, permission or quota failure. Use Google Cloud API metrics to diagnose without logging household addresses or credentials.

The function only claims addresses from the database. Five-minute leases prevent duplicate jobs; changed addresses, stale responses, large unexpected position changes, and newer administrator refreshes cannot be overwritten. Residents cannot execute its database RPCs. The setup has local automated verification; your live Supabase/Google activation must be checked with the steps above.

## Update existing installations: separate manual and scheduled limits

1. In **Supabase → Edge Functions → refresh-geocodes → Code**, replace the code
   with the latest [index.ts](functions/refresh-geocodes/index.ts) and deploy.
   Keep the existing secrets and JWT setting.
2. In **Supabase → SQL Editor**, run the complete
   [009-geocode-batch-limits.sql](migrations/009-geocode-batch-limits.sql).
   Do not rerun setup.sql or migration 006; this update preserves your current cron schedule.
3. Normal refreshes still default to and cannot exceed **10** households. Only
   forced manual requests may specify up to **100**.
4. Run a forced manual refresh once:

   ```sql
   select
     nc_private.enqueue_geocode_refresh (true, 100) as request_id;
   ```

   This selects up to 100 Google-managed households once within that request.
   Manually positioned homes stay untouched. It is not a recurring job or a permanent
   increase to scheduled batch sizes. Google project quotas still apply separately.

5. Copy the returned request ID and inspect that specific response after it completes:

   ```sql
   select
     id,
     status_code,
     timed_out,
     content
   from
     net._http_response
   where
     id = 123;
   
   -- Replace 123 with your request ID.
   ```

   A successful HTTP response includes attempted, refreshed, and failed counts.
   Investigate failures before retrying. Forced requests can refresh the same homes
   again; do not keep rerunning until attempted is zero. For more than 100 households,
   a tracked refresh-all queue is still needed for guaranteed single-pass processing.

The updated worker uses up to 20 concurrent lookups for forced manual batches and
five for normal batches, with eight-second per-request timeouts. Existing leases,
manual-location protection, coordinate validation, and failure tracking remain in place.
No background run or paid Google lookup is triggered by installing this update.
