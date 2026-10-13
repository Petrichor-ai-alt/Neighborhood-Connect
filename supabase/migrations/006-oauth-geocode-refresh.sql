-- Run 004 and 005 first. Replaces the API-key worker, preserves cached coordinates.
BEGIN;

-- BEGIN SUPABASE EXTENSIONS
CREATE EXTENSION IF NOT EXISTS pg_net
WITH
  SCHEMA extensions;

-- END SUPABASE EXTENSIONS
ALTER TABLE nc_private.geocode_refresh_state
ADD COLUMN IF NOT EXISTS lease_token uuid;

ALTER TABLE nc_private.geocode_refresh_state
ADD COLUMN IF NOT EXISTS lease_until timestamptz;

ALTER TABLE nc_private.geocode_refresh_state
ADD COLUMN IF NOT EXISTS lease_address text;

CREATE OR REPLACE FUNCTION public.claim_geocode_refresh (
  batch_size int DEFAULT 10,
  force_refresh boolean DEFAULT FALSE
) RETURNS TABLE (household_id uuid, address text, lease_token uuid) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE h record; token uuid;
BEGIN
  IF batch_size NOT BETWEEN 1 AND 10 OR batch_size IS NULL THEN RAISE EXCEPTION 'Batch size must be 1 to 10'; END IF;
  FOR h IN SELECT homes.id, homes.address FROM public.households homes
    LEFT JOIN public.geocoded_locations g ON g.household_id=homes.id
    LEFT JOIN nc_private.geocode_refresh_state s ON s.household_id=homes.id
    WHERE homes.location_source='google'
      AND (force_refresh OR g.id IS NULL OR g.geocoded_at<=now()-interval '25 days')
      AND (force_refresh OR s.next_attempt IS NULL OR s.next_attempt<=now())
      AND (s.lease_until IS NULL OR s.lease_until<=now())
    ORDER BY g.geocoded_at NULLS FIRST LIMIT batch_size FOR UPDATE OF homes SKIP LOCKED
  LOOP
    token := gen_random_uuid();
    INSERT INTO nc_private.geocode_refresh_state AS s(household_id,last_attempt,next_attempt,lease_token,lease_until,lease_address)
      VALUES(h.id,now(),now()+interval '5 minutes',token,now()+interval '5 minutes',h.address)
      ON CONFLICT ON CONSTRAINT geocode_refresh_state_pkey DO UPDATE SET last_attempt=now(),next_attempt=now()+interval '5 minutes',lease_token=token,lease_until=now()+interval '5 minutes',lease_address=h.address;
    household_id:=h.id; address:=h.address; lease_token:=token; RETURN NEXT;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.claim_geocode_refresh (int, boolean)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON FUNCTION public.claim_geocode_refresh (int, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_geocode_refresh (
  household uuid,
  lease uuid,
  lat double precision,
  lng double precision,
  failure text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE s nc_private.geocode_refresh_state; h public.households; g public.geocoded_locations;
BEGIN
  SELECT * INTO h FROM public.households WHERE id=household FOR UPDATE;
  SELECT * INTO s FROM nc_private.geocode_refresh_state WHERE household_id=household FOR UPDATE;
  IF s.lease_token IS DISTINCT FROM lease OR lease IS NULL OR s.lease_until<=now() THEN RETURN false; END IF;
  IF h.location_source IS DISTINCT FROM 'google' OR h.address IS DISTINCT FROM s.lease_address THEN failure:='ADDRESS_CHANGED'; END IF;
  SELECT * INTO g FROM public.geocoded_locations WHERE household_id=household;
  IF g.geocoded_at>s.last_attempt THEN failure:='NEWER_CACHE'; END IF;
  IF failure IS NULL AND (lat IS NULL OR lng IS NULL OR NOT(lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)) THEN failure:='INVALID_RESULT'; END IF;
  IF failure IS NULL AND g.expires_at>now() AND (abs(lat-g.latitude)>0.003 OR abs(lng-g.longitude)>0.003) THEN failure:='LOCATION_MOVED'; END IF;
  IF failure IS NULL THEN
    INSERT INTO public.geocoded_locations(household_id,latitude,longitude,geocoded_at,expires_at)
      VALUES(household,lat,lng,now(),now()+interval '29 days') ON CONFLICT(household_id) DO UPDATE
      SET latitude=excluded.latitude,longitude=excluded.longitude,geocoded_at=excluded.geocoded_at,expires_at=excluded.expires_at;
    UPDATE nc_private.geocode_refresh_state SET last_success=now(),failures=0,error_code=NULL,next_attempt=now()+interval '25 days',lease_token=NULL,lease_until=NULL,lease_address=NULL WHERE household_id=household;
    RETURN true;
  END IF;
  IF failure NOT IN ('OAUTH','GOOGLE_HTTP','INVALID_RESULT','NETWORK','ADDRESS_CHANGED','NEWER_CACHE','LOCATION_MOVED') THEN failure:='WORKER_ERROR'; END IF;
  UPDATE nc_private.geocode_refresh_state SET failures=failures+1,error_code=failure,next_attempt=now()+make_interval(hours=>least(failures+1,6)),lease_token=NULL,lease_until=NULL,lease_address=NULL WHERE household_id=household;
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.finish_geocode_refresh (
  uuid,
  uuid,
  double precision,
  double precision,
  text
)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON FUNCTION public.finish_geocode_refresh (
  uuid,
  uuid,
  double precision,
  double precision,
  text
) TO service_role;

CREATE OR REPLACE FUNCTION nc_private.enqueue_geocode_refresh (
  force_refresh boolean DEFAULT FALSE,
  batch_size int DEFAULT 10
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE endpoint text; token text; request_id bigint;
BEGIN
  IF batch_size NOT BETWEEN 1 AND 10 OR batch_size IS NULL THEN RAISE EXCEPTION 'Batch size must be 1 to 10'; END IF;
  SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name='nc_refresh_worker_url';
  SELECT decrypted_secret INTO token FROM vault.decrypted_secrets WHERE name='nc_refresh_worker_token';
  IF endpoint IS NULL OR token IS NULL THEN RAISE EXCEPTION 'Configure worker URL and token in Vault'; END IF;
  IF endpoint !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/refresh-geocodes$' THEN RAISE EXCEPTION 'Invalid worker URL'; END IF;
  SELECT net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','x-nc-refresh-token',token),body:=jsonb_build_object('force_refresh',force_refresh,'batch_size',batch_size),timeout_milliseconds:=120000) INTO request_id;
  RETURN request_id;
END $$;

REVOKE ALL ON FUNCTION nc_private.enqueue_geocode_refresh (boolean, int)
FROM
  public,
  anon,
  authenticated;

-- Disable old Google API-key execution, including manual calls.
DROP FUNCTION IF EXISTS nc_private.refresh_due_geocodes (boolean, int);

-- BEGIN SUPABASE CRON
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='nc-refresh-geocodes') THEN PERFORM cron.unschedule('nc-refresh-geocodes'); END IF;
END $$;

SELECT
  cron.schedule (
    'nc-refresh-geocodes',
    '15 * * * *',
    'select nc_private.enqueue_geocode_refresh();'
  );

-- END SUPABASE CRON
COMMIT;
