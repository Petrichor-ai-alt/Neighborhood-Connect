# Activate automatic location refresh

The database checks every hour at minute 15. Google household locations become
eligible after 25 days, four days before their 29-day expiration. A successful
new lookup renews the expiry. Errors leave still-valid coordinates in place and
retry with a one-to-six-hour backoff. Cleanup still runs at minute 0. Neither job
needs the website open. Manual coordinates are never changed by the refresh job.

## 1. Install the migration

After migration 004, run the complete contents of
`supabase/migrations/005-background-geocode-refresh.sql` in **Supabase → SQL
Editor → New query**. It enables HTTP/Vault support and installs the refresh job.
It is safe to repeat. Until the Vault key is configured, a job attempt reports a
missing-key error and leaves household data unchanged.

## 2. Create a separate server key

In your existing Google Cloud project:

1. Confirm **Geocoding API** is enabled.
2. Open **APIs & Services → Credentials → Create credentials → API key**.
3. Name it **Neighborhood Connect Background Geocoding**.
4. Under **Application restrictions**, select **None**. Database requests cannot
   use the website/referrer restriction on your existing browser key.
5. Under **API restrictions**, select **Restrict key** and choose only
   **Geocoding API**. Save.

Keep the existing website-restricted key unchanged. Do not put the new server key
in `config.js`, GitHub, or chat. This server key is used only from the database.

## 3. Store it in Supabase Vault

Open **Vault** in your Supabase project (use dashboard search for “Vault” if
needed). Add a secret with:

- **Name:** `nc_google_geocoding_key`
- **Secret/value:** the new server API key
- **Description:** `Background household location refresh`

Save it. The migration protects the decrypted-secret view from website roles.
The job reads this secret internally and never returns it or stores raw Google
responses in its status table.

## 4. Verify and test

Check both schedules in SQL Editor:

```sql
SELECT
  jobname,
  schedule,
  active
FROM
  cron.job
WHERE
  jobname IN (
    'nc-refresh-geocodes',
    'nc-purge-expired-geocodes'
  );
```

Expected: refresh `15 * * * *`, cleanup `0 * * * *`, both active.

Test one Google household immediately, without changing dates:

```sql
SELECT
  nc_private.refresh_due_geocodes (true, 1);
```

This makes a real Google request and persists a renewed cache if successful.
Expected: `refreshed: 1`, `failed: 0`. If no household uses Google-derived
coordinates, `refreshed: 0` is normal; create and approve a test signup through
automatic address lookup first. Manually entered households are excluded.

Inspect refresh status without exposing the key:

```sql
SELECT
  h.display_name,
  s.last_attempt,
  s.last_success,
  s.error_code,
  s.failures,
  s.next_attempt
FROM
  nc_private.geocode_refresh_state AS s
  JOIN public.households AS h ON h.id = s.household_id
ORDER BY
  s.last_attempt DESC;
```

`REQUEST_DENIED` usually means the server key/API configuration needs attention.
`OVER_QUERY_LIMIT` or `OVER_DAILY_LIMIT` requires checking Google's quota/billing.
Ambiguous, partial, coarse, and substantially moved locations are rejected rather
than silently replacing an approved pin. Raw Google error messages are not stored.

Inspect scheduled executions:

```sql
SELECT
  status,
  return_message,
  start_time,
  end_time
FROM
  cron.job_run_details
WHERE
  jobid IN (
    SELECT
      jobid
    FROM
      cron.job
    WHERE
      jobname = 'nc-refresh-geocodes'
  )
ORDER BY
  start_time DESC
LIMIT
  10;
```

The default job processes at most ten households per run, oldest first. Valid
recent locations are skipped. Missing Google caches can be recovered from a new
lookup. Persistent failures never extend old coordinates beyond expiration;
profiles remain available even if their map pins temporarily disappear.

Local automated tests run the real refresh function with deterministic HTTP and
Vault adapters. Actual extension installation, encrypted Vault storage, Cron
execution, and Google authorization are verified with the activation steps above.
