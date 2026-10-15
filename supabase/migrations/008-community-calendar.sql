-- Requires setup.sql and migration 002. Safe to repeat on existing projects.
BEGIN;

ALTER TABLE public.neighborhoods
ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'America/Chicago';

CREATE TABLE IF NOT EXISTS public.neighborhood_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_id uuid NOT NULL REFERENCES public.neighborhoods (id),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  organizer_name text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 300),
  all_day boolean NOT NULL DEFAULT FALSE,
  starts_at timestamptz,
  ends_at timestamptz,
  start_date date,
  end_date date,
  time_zone text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      all_day
      AND starts_at IS NULL
      AND ends_at IS NULL
      AND start_date IS NOT NULL
      AND end_date IS NOT NULL
      AND isfinite(start_date)
      AND isfinite(end_date)
      AND end_date > start_date
      AND end_date <= start_date + 366
    )
    OR (
      NOT all_day
      AND start_date IS NULL
      AND end_date IS NULL
      AND starts_at IS NOT NULL
      AND ends_at IS NOT NULL
      AND isfinite(starts_at)
      AND isfinite(ends_at)
      AND ends_at > starts_at
      AND ends_at <= starts_at + interval '366 days'
    )
  )
);

CREATE INDEX IF NOT EXISTS neighborhood_events_times ON public.neighborhood_events (neighborhood_id, starts_at);

CREATE INDEX IF NOT EXISTS neighborhood_events_days ON public.neighborhood_events (neighborhood_id, start_date);

ALTER TABLE public.neighborhood_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neighborhood_events
FROM
  public,
  anon,
  authenticated;

GRANT
SELECT
  ON public.neighborhood_events TO authenticated;

DROP POLICY IF EXISTS events_for_neighbors ON public.neighborhood_events;

CREATE POLICY events_for_neighbors ON public.neighborhood_events FOR
SELECT
  TO authenticated USING (nc_private.is_member (neighborhood_id));

-- Table writes are RPC-only: organizer identity, neighborhood and revisions cannot be forged.
CREATE OR REPLACE FUNCTION public.save_neighborhood_event (
  neighborhood uuid,
  event_id uuid,
  expected_revision integer,
  event_title text,
  event_description text,
  event_location text,
  is_all_day boolean,
  start_time timestamptz DEFAULT NULL,
  end_time timestamptz DEFAULT NULL,
  first_day date DEFAULT NULL,
  exclusive_last_day date DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  existing public.neighborhood_events;
  zone text;
  organizer text;
  result uuid;
BEGIN
  -- Lock membership against concurrent access revocation until this transaction ends.
  PERFORM 1 FROM public.memberships
    WHERE user_id=auth.uid() AND neighborhood_id=neighborhood FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved neighborhood access required';
  END IF;
  SELECT time_zone INTO zone FROM public.neighborhoods WHERE id=neighborhood;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) THEN
    RAISE EXCEPTION 'The neighborhood timezone needs administrator attention';
  END IF;
  IF event_id IS NOT NULL THEN
    SELECT * INTO existing FROM public.neighborhood_events
      WHERE id=event_id AND neighborhood_id=neighborhood FOR UPDATE;
    IF existing.id IS NULL OR
      (existing.created_by IS DISTINCT FROM auth.uid() AND NOT nc_private.is_admin(neighborhood)) THEN
      RAISE EXCEPTION 'Only the organizer or a neighborhood administrator can edit this event';
    END IF;
    IF expected_revision IS DISTINCT FROM existing.revision THEN
      RAISE EXCEPTION 'This event changed. Close it and reopen the latest version before editing';
    END IF;
    UPDATE public.neighborhood_events SET
      title=trim(event_title), description=event_description, location=trim(event_location),
      all_day=is_all_day, starts_at=start_time, ends_at=end_time,
      start_date=first_day, end_date=exclusive_last_day,
      time_zone=zone, revision=revision+1, updated_at=now()
      WHERE id=existing.id;
    RETURN existing.id;
  END IF;
  SELECT p.display_name INTO organizer FROM public.household_members p
    JOIN public.households h ON h.id=p.household_id
    WHERE p.user_id=auth.uid() AND h.neighborhood_id=neighborhood LIMIT 1;
  INSERT INTO public.neighborhood_events(
    neighborhood_id,created_by,organizer_name,title,description,location,
    all_day,starts_at,ends_at,start_date,end_date,time_zone
  ) VALUES (
    neighborhood,auth.uid(),coalesce(organizer,'A neighbor'),trim(event_title),event_description,trim(event_location),
    is_all_day,start_time,end_time,first_day,exclusive_last_day,zone
  ) RETURNING id INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.save_neighborhood_event (
  uuid,
  uuid,
  integer,
  text,
  text,
  text,
  boolean,
  timestamptz,
  timestamptz,
  date,
  date
)
FROM
  public,
  anon;

GRANT
EXECUTE ON FUNCTION public.save_neighborhood_event (
  uuid,
  uuid,
  integer,
  text,
  text,
  text,
  boolean,
  timestamptz,
  timestamptz,
  date,
  date
) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_neighborhood_event (event_id uuid, expected_revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  existing public.neighborhood_events;
BEGIN
  SELECT * INTO existing FROM public.neighborhood_events WHERE id=event_id;
  PERFORM 1 FROM public.memberships
    WHERE user_id=auth.uid() AND neighborhood_id=existing.neighborhood_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved neighborhood access required';
  END IF;
  SELECT * INTO existing FROM public.neighborhood_events WHERE id=event_id FOR UPDATE;
  IF existing.created_by IS DISTINCT FROM auth.uid() AND NOT nc_private.is_admin(existing.neighborhood_id) THEN
    RAISE EXCEPTION 'Only the organizer or a neighborhood administrator can cancel this event';
  END IF;
  IF expected_revision IS DISTINCT FROM existing.revision THEN
    RAISE EXCEPTION 'This event changed. Reopen the latest version before cancelling';
  END IF;
  UPDATE public.neighborhood_events SET status='cancelled',revision=revision+1,updated_at=now()
    WHERE id=event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_neighborhood_event (uuid, integer)
FROM
  public,
  anon;

GRANT
EXECUTE ON FUNCTION public.cancel_neighborhood_event (uuid, integer) TO authenticated;

-- SECURITY INVOKER deliberately applies the same RLS as direct directory queries.
CREATE OR REPLACE FUNCTION public.list_neighborhood_events (
  neighborhood uuid,
  range_start timestamptz,
  range_end timestamptz,
  first_day date,
  exclusive_last_day date
) RETURNS SETOF public.neighborhood_events LANGUAGE sql STABLE SECURITY INVOKER
SET
  search_path = '' AS $$
  SELECT * FROM public.neighborhood_events e
  WHERE e.neighborhood_id=neighborhood
    AND range_end>range_start AND range_end<=range_start+interval '370 days'
    AND exclusive_last_day>first_day AND exclusive_last_day<=first_day+370
    AND (
      (e.all_day AND e.start_date<exclusive_last_day AND e.end_date>first_day)
      OR (NOT e.all_day AND e.starts_at<range_end AND e.ends_at>range_start)
    )
  ORDER BY coalesce(e.starts_at,e.start_date::timestamp AT TIME ZONE e.time_zone),e.id;
$$;

REVOKE ALL ON FUNCTION public.list_neighborhood_events (uuid, timestamptz, timestamptz, date, date)
FROM
  public,
  anon;

GRANT
EXECUTE ON FUNCTION public.list_neighborhood_events (uuid, timestamptz, timestamptz, date, date) TO authenticated;

-- Keep shared events when an account is deleted, while removing organizer attribution.
CREATE OR REPLACE FUNCTION nc_private.anonymize_event_organizer () RETURNS trigger LANGUAGE plpgsql
SET
  search_path = '' AS $$
BEGIN
  IF OLD.created_by IS NOT NULL AND NEW.created_by IS NULL THEN
    NEW.organizer_name := 'Former neighbor';
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION nc_private.anonymize_event_organizer ()
FROM
  public,
  anon,
  authenticated;

DROP TRIGGER IF EXISTS event_organizer_deleted ON public.neighborhood_events;

CREATE TRIGGER event_organizer_deleted
BEFORE UPDATE OF created_by ON public.neighborhood_events FOR EACH ROW
EXECUTE FUNCTION nc_private.anonymize_event_organizer ();

COMMIT;
