-- Run 002 and 003 first. This upgrade is transactional and safe to repeat.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT
      1
    FROM
      information_schema.columns
    WHERE
      table_schema = 'public'
      AND table_name = 'memberships'
      AND column_name = 'household_role') THEN
  RAISE EXCEPTION 'Run the household-members upgrade first';
END IF;
END
$$;

ALTER TABLE public.households
ADD COLUMN IF NOT EXISTS location_source text NOT NULL DEFAULT 'manual' CHECK (location_source IN ('manual', 'google'));

ALTER TABLE public.households
ALTER COLUMN latitude
DROP NOT NULL;

ALTER TABLE public.households
ALTER COLUMN longitude
DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.geocoded_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid UNIQUE REFERENCES public.access_requests (id) ON DELETE CASCADE,
  household_id uuid UNIQUE REFERENCES public.households (id) ON DELETE CASCADE,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  geocoded_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '29 days',
  CHECK (num_nonnulls (request_id, household_id) = 1),
  CHECK (
    expires_at > geocoded_at
    AND expires_at <= geocoded_at + interval '29 days'
  )
);

ALTER TABLE public.geocoded_locations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.geocoded_locations
FROM
  public,
  anon,
  authenticated;

GRANT
SELECT
  ON public.geocoded_locations TO authenticated;

DROP POLICY IF EXISTS geocoded_location_access ON public.geocoded_locations;

CREATE POLICY geocoded_location_access ON public.geocoded_locations FOR
SELECT
  TO authenticated USING (
    expires_at > now()
    AND (
      EXISTS (
        SELECT
          1
        FROM
          public.access_requests r
        WHERE
          r.id = request_id
          AND (
            r.user_id = auth.uid ()
            OR nc_private.is_admin (r.neighborhood_id)
          )
      )
      OR EXISTS (
        SELECT
          1
        FROM
          public.households h
        WHERE
          h.id = household_id
          AND nc_private.is_member (h.neighborhood_id)
      )
    )
  );

CREATE OR REPLACE FUNCTION public.geocoding_ready () RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT
    auth.uid () IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.save_request_geocode (
  request_id uuid,
  lat double precision,
  lng double precision
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  r public.access_requests;
BEGIN
  SELECT
    * INTO r
  FROM
    public.access_requests
  WHERE
    id = request_id
  FOR UPDATE;
  IF r.id IS NULL OR auth.uid () IS NULL OR (r.user_id <> auth.uid () AND NOT nc_private.is_admin (r.neighborhood_id)) THEN
    RAISE EXCEPTION 'Request owner or neighborhood administrator access required';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'Request is no longer pending';
  END IF;
  IF lat IS NULL OR lng IS NULL THEN
    RAISE EXCEPTION 'Address coordinates required';
  END IF;
  INSERT INTO public.geocoded_locations (request_id, latitude, longitude)
    VALUES (r.id, lat, lng)
  ON CONFLICT ON CONSTRAINT geocoded_locations_request_id_key
    DO UPDATE SET
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      geocoded_at = now(),
      expires_at = now() + interval '29 days';
END;
$$;

CREATE OR REPLACE FUNCTION public.review_geocoded_request (
  request_id uuid,
  approve boolean,
  existing_household uuid DEFAULT NULL,
  manual_lat double precision DEFAULT NULL,
  manual_lng double precision DEFAULT NULL,
  use_google boolean DEFAULT TRUE
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  r public.access_requests;
  candidate public.geocoded_locations;
  h uuid;
BEGIN
  SELECT
    * INTO r
  FROM
    public.access_requests
  WHERE
    id = request_id
  FOR UPDATE;
  IF r.id IS NULL OR NOT nc_private.is_admin (r.neighborhood_id) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;
  IF approve AND existing_household IS NULL AND use_google THEN
    SELECT
      * INTO candidate
    FROM
      public.geocoded_locations g
    WHERE
      g.request_id = r.id
      AND g.expires_at > now()
    FOR UPDATE;
    IF candidate.id IS NULL THEN
      RAISE EXCEPTION 'Look up this address again or enter coordinates manually';
    END IF;
    PERFORM
      public.review_request (r.id, TRUE, candidate.latitude, candidate.longitude, NULL);
    SELECT
      household_id INTO h
    FROM
      public.memberships
    WHERE
      user_id = r.user_id
      AND neighborhood_id = r.neighborhood_id;
    -- Google coordinates live only in the expiring cache, never in permanent household fields.
    UPDATE
      public.households
    SET
      location_source = 'google',
      latitude = NULL,
      longitude = NULL
    WHERE
      id = h;
    UPDATE
      public.geocoded_locations
    SET
      request_id = NULL,
      household_id = h
    WHERE
      id = candidate.id;
  ELSE
    PERFORM
      public.review_request (r.id, approve, manual_lat, manual_lng, existing_household);
    DELETE FROM public.geocoded_locations g
    WHERE g.request_id = r.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_household_geocode (
  household uuid,
  lat double precision,
  lng double precision
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  h public.households;
BEGIN
  SELECT
    * INTO h
  FROM
    public.households
  WHERE
    id = household
  FOR UPDATE;
  IF h.id IS NULL OR NOT nc_private.is_admin (h.neighborhood_id) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;
  IF h.location_source <> 'google' THEN
    RAISE EXCEPTION 'Manually verified coordinates are preserved';
  END IF;
  IF lat IS NULL OR lng IS NULL THEN
    RAISE EXCEPTION 'Address coordinates required';
  END IF;
  INSERT INTO public.geocoded_locations (household_id, latitude, longitude)
    VALUES (h.id, lat, lng)
  ON CONFLICT (household_id)
    DO UPDATE SET
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      geocoded_at = now(),
      expires_at = now() + interval '29 days';
END;
$$;

REVOKE ALL ON FUNCTION public.geocoding_ready (),
public.save_request_geocode (uuid, double precision, double precision),
public.review_geocoded_request (
  uuid,
  boolean,
  uuid,
  double precision,
  double precision,
  boolean
),
public.refresh_household_geocode (uuid, double precision, double precision)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON FUNCTION public.geocoding_ready (),
public.save_request_geocode (uuid, double precision, double precision),
public.review_geocoded_request (
  uuid,
  boolean,
  uuid,
  double precision,
  double precision,
  boolean
),
public.refresh_household_geocode (uuid, double precision, double precision) TO authenticated;

CREATE OR REPLACE FUNCTION nc_private.purge_expired_geocodes () RETURNS void LANGUAGE sql SECURITY DEFINER
SET
  search_path = '' AS $$
  DELETE FROM public.geocoded_locations
  WHERE expires_at <= now();
$$;

REVOKE ALL ON FUNCTION nc_private.purge_expired_geocodes ()
FROM
  public,
  anon,
  authenticated;

-- BEGIN SUPABASE CRON: local PostgreSQL tests exercise cleanup directly instead.
CREATE EXTENSION IF NOT EXISTS pg_cron
WITH
  SCHEMA pg_catalog;

SELECT
  cron.schedule (
    'nc-purge-expired-geocodes',
    '0 * * * *',
    'select nc_private.purge_expired_geocodes();'
  );

-- END SUPABASE CRON
NOTIFY pgrst,
'reload schema';

COMMIT;
