-- Superseded by 006-oauth-geocode-refresh.sql; run both in order for new installs.
-- Run 004 first. Then configure nc_google_geocoding_key in Supabase Vault.
-- This migration is transactional and safe to repeat. Never put the key in this file.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.geocoded_locations') IS NULL THEN
    RAISE EXCEPTION 'Run 004-address-geocoding.sql first';
  END IF;
END
$$;

-- BEGIN SUPABASE EXTENSIONS: local tests provide fake HTTP and Vault adapters.
CREATE EXTENSION IF NOT EXISTS http
WITH
  SCHEMA extensions;

CREATE EXTENSION IF NOT EXISTS supabase_vault
WITH
  SCHEMA vault;

CREATE EXTENSION IF NOT EXISTS pg_cron
WITH
  SCHEMA pg_catalog;

REVOKE ALL ON vault.decrypted_secrets,
vault.secrets
FROM
  public,
  anon,
  authenticated;

-- END SUPABASE EXTENSIONS
CREATE TABLE IF NOT EXISTS nc_private.geocode_refresh_state (
  household_id uuid PRIMARY KEY REFERENCES public.households (id) ON DELETE CASCADE,
  last_attempt timestamptz NOT NULL,
  last_success timestamptz,
  error_code text,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  next_attempt timestamptz NOT NULL
);

ALTER TABLE nc_private.geocode_refresh_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON nc_private.geocode_refresh_state
FROM
  public,
  anon,
  authenticated;

-- Validate the response without persisting Google's response or error_message.
CREATE OR REPLACE FUNCTION nc_private.parse_geocode_response (payload jsonb) RETURNS TABLE (
  latitude double precision,
  longitude double precision,
  error_code text
) LANGUAGE plpgsql
SET
  search_path = '' AS $$
DECLARE
  result jsonb;
  components jsonb;
  status text;
BEGIN
  status = payload ->> 'status';
  IF status IS DISTINCT FROM 'OK' THEN
    error_code = CASE WHEN status IN ('ZERO_RESULTS', 'REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT', 'UNKNOWN_ERROR', 'INVALID_REQUEST') THEN
      status
    ELSE
      'UNKNOWN_STATUS'
    END;
    RETURN NEXT;
    RETURN;
  END IF;
  IF jsonb_typeof(payload -> 'results') IS DISTINCT FROM 'array' OR jsonb_array_length(payload -> 'results') <> 1 THEN
    error_code = 'AMBIGUOUS_ADDRESS';
    RETURN NEXT;
    RETURN;
  END IF;
  result = payload -> 'results' -> 0;
  IF coalesce((result ->> 'partial_match')::boolean, FALSE) THEN
    error_code = 'PARTIAL_MATCH';
    RETURN NEXT;
    RETURN;
  END IF;
  IF (result -> 'geometry' ->> 'location_type') IS NULL OR (result -> 'geometry' ->> 'location_type')
NOT IN ('ROOFTOP', 'RANGE_INTERPOLATED') THEN
    error_code = 'APPROXIMATE_LOCATION';
    RETURN NEXT;
    RETURN;
  END IF;
  components = coalesce(result -> 'address_components', '[]'::jsonb);
  IF NOT EXISTS (
    SELECT
      1
    FROM
      jsonb_array_elements(components) c
    WHERE
      c -> 'types' ? 'street_number')
    OR NOT EXISTS (
      SELECT
        1
      FROM
        jsonb_array_elements(components) c
      WHERE
        c -> 'types' ? 'route')
    OR NOT EXISTS (
      SELECT
        1
      FROM
        jsonb_array_elements(components) c
      WHERE
        c -> 'types' ? 'country'
        AND c ->> 'short_name' = 'US') THEN
    error_code = 'INCOMPLETE_ADDRESS';
  RETURN NEXT;
  RETURN;
END IF;
  latitude = (result -> 'geometry' -> 'location' ->> 'lat')::double precision;
  longitude = (result -> 'geometry' -> 'location' ->> 'lng')::double precision;
  IF latitude IS NULL OR longitude IS NULL OR NOT (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180) THEN
    latitude = NULL;
    longitude = NULL;
    error_code = 'INVALID_COORDINATES';
  END IF;
  RETURN NEXT;
EXCEPTION
  WHEN OTHERS THEN
    latitude = NULL;
    longitude = NULL;
    error_code = 'MALFORMED_RESPONSE';
    RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION nc_private.parse_geocode_response (jsonb)
FROM
  public,
  anon,
  authenticated;

CREATE OR REPLACE FUNCTION nc_private.refresh_due_geocodes (
  force_refresh boolean DEFAULT FALSE,
  batch_size integer DEFAULT 10
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  api_key text;
  h record;
  reply record;
  point record;
  payload jsonb;
  error text;
  refreshed integer = 0;
  failed integer = 0;
  skipped integer = 0;
  saved integer;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 25 THEN
    RAISE EXCEPTION 'Batch size must be between 1 and 25';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('nc-background-geocoding', 0)) THEN
    RETURN jsonb_build_object('status', 'busy', 'refreshed', 0, 'failed', 0, 'skipped', 0);
  END IF;
  SELECT
    decrypted_secret INTO api_key
  FROM
    vault.decrypted_secrets
  WHERE
    name = 'nc_google_geocoding_key';
  IF api_key IS NULL OR trim(api_key) = '' THEN
    RAISE EXCEPTION 'Add nc_google_geocoding_key to Supabase Vault before running background refresh';
  END IF;
  FOR h IN
  SELECT
    home.id,
    home.address,
    c.latitude,
    c.longitude,
    c.geocoded_at
  FROM
    public.households home
    LEFT JOIN public.geocoded_locations c ON c.household_id = home.id
    LEFT JOIN nc_private.geocode_refresh_state state ON state.household_id = home.id
  WHERE
    home.location_source = 'google'
    AND (force_refresh
      OR c.id IS NULL
      OR c.geocoded_at <= now() - interval '25 days')
    AND (force_refresh
      OR state.next_attempt IS NULL
      OR state.next_attempt <= now())
  ORDER BY
    coalesce(c.geocoded_at, '-infinity'::timestamptz),
    home.id
  LIMIT batch_size LOOP
    error = NULL;
    BEGIN
      SELECT
        * INTO reply
      FROM
        extensions.http_get ('https://maps.googleapis.com/maps/api/geocode/json', jsonb_build_object('address', h.address, 'components', 'country:US', 'key', api_key));
      IF reply.status <> 200 THEN
        error = 'HTTP_ERROR';
      ELSE
        payload = reply.content::jsonb;
        SELECT
          * INTO point
        FROM
          nc_private.parse_geocode_response (payload);
        error = point.error_code;
        -- A large change to a still-cached approved location requires administrator review.
        IF error IS NULL AND h.latitude IS NOT NULL AND h.longitude IS NOT NULL AND (abs(point.latitude - h.latitude) > 0.003 OR abs(point.longitude - h.longitude) > 0.003) THEN
          error = 'LOCATION_MOVED';
        END IF;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        -- Do not log SQLERRM: an HTTP error could contain the request URL or API key.
        error = 'NETWORK_OR_RESPONSE_ERROR';
    END;
    IF error IS NULL THEN
      PERFORM
        1
      FROM
        public.households home
      WHERE
        home.id = h.id
        AND home.location_source = 'google'
        AND home.address = h.address
      FOR UPDATE;
      IF NOT found THEN
        skipped = skipped + 1;
        CONTINUE;
        END IF;
      INSERT INTO public.geocoded_locations AS cached (household_id, latitude, longitude)
        VALUES (h.id, point.latitude, point.longitude)
      ON CONFLICT (household_id)
        DO UPDATE SET
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          geocoded_at = excluded.geocoded_at,
          expires_at = excluded.expires_at
        WHERE
          cached.geocoded_at <= excluded.geocoded_at;
        get diagnostics saved = row_count;
        IF saved = 0 THEN
          skipped = skipped + 1;
          CONTINUE;
          END IF;
      INSERT INTO nc_private.geocode_refresh_state (household_id, last_attempt, last_success, error_code, failures, next_attempt)
        VALUES (h.id, now(), now(), NULL, 0, now() + interval '25 days')
      ON CONFLICT (household_id)
        DO UPDATE SET
          last_attempt = now(),
          last_success = now(),
          error_code = NULL,
          failures = 0,
          next_attempt = excluded.next_attempt;
        refreshed = refreshed + 1;
      ELSE
        INSERT INTO nc_private.geocode_refresh_state AS state (household_id, last_attempt, error_code, failures, next_attempt)
          VALUES (h.id, now(), error, 1, now() + interval '1 hour')
        ON CONFLICT (household_id)
          DO UPDATE SET
            last_attempt = now(),
            error_code = excluded.error_code,
            failures = state.failures + 1,
            next_attempt = now() + make_interval(hours => least (6, state.failures + 1));
          failed = failed + 1;
          -- Project-wide authorization/quota failures cannot be solved by more requests this run.
          IF error IN ('REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT') THEN
            exit;
            END IF;
      END IF;
  END LOOP;
  RETURN jsonb_build_object('status', 'complete', 'refreshed', refreshed, 'failed', failed, 'skipped', skipped);
END;
$$;

REVOKE ALL ON FUNCTION nc_private.refresh_due_geocodes (boolean, integer)
FROM
  public,
  anon,
  authenticated;

-- BEGIN SUPABASE CRON: test runtime exercises the function directly.
SELECT
  cron.schedule (
    'nc-refresh-geocodes',
    '15 * * * *',
    'select nc_private.refresh_due_geocodes();'
  );

-- END SUPABASE CRON
NOTIFY pgrst,
'reload schema';

COMMIT;
