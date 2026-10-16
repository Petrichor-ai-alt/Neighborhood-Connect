-- Larger forced manual batches; normal batches remain capped at 10.
-- Run after 006. Does not change cron schedules, cached coordinates, or Google quotas.
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_geocode_refresh (
  batch_size int DEFAULT 10,
  force_refresh boolean DEFAULT FALSE
) RETURNS TABLE (household_id uuid, address text, lease_token uuid) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  h record;
  token uuid;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > (CASE WHEN force_refresh THEN 100 ELSE 10 END) THEN
    RAISE EXCEPTION 'Batch size must be 1 to 10 normally, or 1 to 100 for a forced manual refresh';
  END IF;
  FOR h IN
    SELECT homes.id, homes.address
    FROM public.households homes
    LEFT JOIN public.geocoded_locations g ON g.household_id=homes.id
    LEFT JOIN nc_private.geocode_refresh_state s ON s.household_id=homes.id
    WHERE homes.location_source='google'
      AND (force_refresh OR g.id IS NULL OR g.geocoded_at<=now()-interval '25 days')
      AND (force_refresh OR s.next_attempt IS NULL OR s.next_attempt<=now())
      AND (s.lease_until IS NULL OR s.lease_until<=now())
    ORDER BY g.geocoded_at NULLS FIRST, homes.id LIMIT batch_size FOR UPDATE OF homes SKIP LOCKED
  LOOP
    token := gen_random_uuid();
    INSERT INTO nc_private.geocode_refresh_state AS s(household_id,last_attempt,next_attempt,lease_token,lease_until,lease_address)
      VALUES(h.id,now(),now()+interval '5 minutes',token,now()+interval '5 minutes',h.address)
      ON CONFLICT ON CONSTRAINT geocode_refresh_state_pkey DO UPDATE SET last_attempt=now(),next_attempt=now()+interval '5 minutes',lease_token=token,lease_until=now()+interval '5 minutes',lease_address=h.address;
    household_id := h.id;
    address := h.address;
    lease_token := token;
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.claim_geocode_refresh (int, boolean)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON FUNCTION public.claim_geocode_refresh (int, boolean) TO service_role;

CREATE OR REPLACE FUNCTION nc_private.enqueue_geocode_refresh (
  force_refresh boolean DEFAULT FALSE,
  batch_size int DEFAULT 10
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  endpoint text;
  token text;
  request_id bigint;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > (CASE WHEN force_refresh THEN 100 ELSE 10 END) THEN
    RAISE EXCEPTION 'Batch size must be 1 to 10 normally, or 1 to 100 for a forced manual refresh';
  END IF;
  SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name='nc_refresh_worker_url';
  SELECT decrypted_secret INTO token FROM vault.decrypted_secrets WHERE name='nc_refresh_worker_token';
  IF endpoint IS NULL OR token IS NULL THEN
    RAISE EXCEPTION 'Configure worker URL and token in Vault';
  END IF;
  IF endpoint !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/refresh-geocodes$' THEN
    RAISE EXCEPTION 'Invalid worker URL';
  END IF;
  SELECT net.http_post(
    url := endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-nc-refresh-token', token
    ),
    body := jsonb_build_object(
      'force_refresh', force_refresh,
      'batch_size', batch_size
    ),
    timeout_milliseconds := 120000
  ) INTO request_id;
  RETURN request_id;
END $$;

REVOKE ALL ON FUNCTION nc_private.enqueue_geocode_refresh (boolean, int)
FROM
  public,
  anon,
  authenticated;

NOTIFY pgrst,
'reload schema';

COMMIT;
