-- Run once in the Supabase SQL Editor on a new project.
BEGIN;

CREATE SCHEMA IF NOT EXISTS nc_private;

REVOKE ALL ON SCHEMA nc_private
FROM
  public;

GRANT usage ON SCHEMA nc_private TO authenticated;

CREATE TABLE public.neighborhoods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE TABLE public.households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_id uuid NOT NULL REFERENCES public.neighborhoods (id),
  address text NOT NULL CHECK (length(address) BETWEEN 5 AND 250),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  residents text NOT NULL DEFAULT '' CHECK (length(residents) <= 300),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 200),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  interests text NOT NULL DEFAULT '' CHECK (length(interests) <= 500),
  bio text NOT NULL DEFAULT '' CHECK (length(bio) <= 1500),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180)
);

CREATE UNIQUE INDEX households_address ON public.households (neighborhood_id, lower(trim(address)));

CREATE TABLE public.memberships (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  neighborhood_id uuid NOT NULL REFERENCES public.neighborhoods (id),
  household_id uuid NOT NULL REFERENCES public.households (id),
  role text NOT NULL DEFAULT 'resident' CHECK (ROLE IN ('resident', 'admin')),
  PRIMARY KEY (user_id, neighborhood_id)
);

CREATE TABLE public.access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  neighborhood_id uuid NOT NULL REFERENCES public.neighborhoods (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  address text NOT NULL CHECK (length(address) BETWEEN 5 AND 250),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, neighborhood_id)
);

CREATE INDEX memberships_household ON public.memberships (household_id);

CREATE INDEX requests_neighborhood ON public.access_requests (neighborhood_id);

CREATE FUNCTION nc_private.is_member (n uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT
    EXISTS (
      SELECT
        1
      FROM
        public.memberships m
      WHERE
        m.user_id = auth.uid ()
        AND m.neighborhood_id = n);
$$;

CREATE FUNCTION nc_private.is_admin (n uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT
    EXISTS (
      SELECT
        1
      FROM
        public.memberships m
      WHERE
        m.user_id = auth.uid ()
        AND m.neighborhood_id = n
        AND m.role = 'admin');
$$;

CREATE FUNCTION nc_private.can_edit (h uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT
    EXISTS (
      SELECT
        1
      FROM
        public.memberships m
      WHERE
        m.user_id = auth.uid ()
        AND m.household_id = h);
$$;

CREATE FUNCTION nc_private.photo_access (path text, writing boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT
    EXISTS (
      SELECT
        1
      FROM
        public.households h
        JOIN public.memberships m ON m.neighborhood_id = h.neighborhood_id
      WHERE
        m.user_id = auth.uid ()
        AND h.id::text = split_part(path, '/', 1)
        AND (NOT writing
          OR m.household_id = h.id));
$$;

REVOKE ALL ON FUNCTION nc_private.is_member (uuid),
nc_private.is_admin (uuid),
nc_private.can_edit (uuid),
nc_private.photo_access (text, boolean)
FROM
  public;

GRANT
EXECUTE ON FUNCTION nc_private.is_member (uuid),
nc_private.is_admin (uuid),
nc_private.can_edit (uuid),
nc_private.photo_access (text, boolean) TO authenticated;

ALTER TABLE public.neighborhoods ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.households ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neighborhoods,
public.households,
public.memberships,
public.access_requests
FROM
  anon,
  authenticated;

GRANT
SELECT
  ON public.neighborhoods TO anon,
  authenticated;

GRANT
SELECT
  ON public.households,
  public.memberships,
  public.access_requests TO authenticated;

GRANT
UPDATE (
  display_name,
  residents,
  email,
  phone,
  interests,
  bio
) ON public.households TO authenticated;

CREATE POLICY neighborhood_branding ON public.neighborhoods FOR
SELECT
  TO anon,
  authenticated USING (TRUE);

CREATE POLICY directory_approved_only ON public.households FOR
SELECT
  TO authenticated USING (nc_private.is_member (neighborhood_id));

CREATE POLICY edit_own_household ON public.households
FOR UPDATE
  TO authenticated USING (nc_private.can_edit (id))
WITH
  CHECK (nc_private.can_edit (id));

CREATE POLICY own_membership ON public.memberships FOR
SELECT
  TO authenticated USING (user_id = auth.uid ());

CREATE POLICY own_or_admin_request ON public.access_requests FOR
SELECT
  TO authenticated USING (
    user_id = auth.uid ()
    OR nc_private.is_admin (neighborhood_id)
  );

CREATE FUNCTION public.request_access (
  neighborhood_slug text,
  resident_name text,
  household_address text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  n uuid;
BEGIN
  IF auth.uid () IS NULL THEN
    RAISE EXCEPTION 'Sign in first';
  END IF;
  SELECT
    id INTO n
  FROM
    public.neighborhoods
  WHERE
    slug = neighborhood_slug;
  IF n IS NULL THEN
    RAISE EXCEPTION 'Neighborhood not found';
  END IF;
  IF nc_private.is_member (n) THEN
    RAISE EXCEPTION 'Already approved';
  END IF;
  INSERT INTO public.access_requests (user_id, neighborhood_id, name, address)
    VALUES (auth.uid (), n, trim(resident_name), trim(household_address));
END;
$$;

CREATE FUNCTION public.review_request (
  request_id uuid,
  approve boolean,
  lat double precision DEFAULT NULL,
  lng double precision DEFAULT NULL,
  existing_household uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  r public.access_requests;
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
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'Request already reviewed';
  END IF;
  IF approve THEN
    IF existing_household IS NOT NULL THEN
      SELECT
        id INTO h
      FROM
        public.households
      WHERE
        id = existing_household
        AND neighborhood_id = r.neighborhood_id;
      IF h IS NULL THEN
        RAISE EXCEPTION 'Household is not in this neighborhood';
      END IF;
    ELSE
      IF lat IS NULL OR lng IS NULL THEN
        RAISE EXCEPTION 'Verified map coordinates required';
      END IF;
      INSERT INTO public.households (neighborhood_id, address, display_name, latitude, longitude)
        VALUES (r.neighborhood_id, r.address, r.name || ' household', lat, lng)
      RETURNING
        id INTO h;
    END IF;
    INSERT INTO public.memberships (user_id, neighborhood_id, household_id)
      VALUES (r.user_id, r.neighborhood_id, h);
  END IF;
  UPDATE
    public.access_requests
  SET
    status = CASE WHEN approve THEN
      'approved'
    ELSE
      'rejected'
    END
  WHERE
    id = r.id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_access (text, text, text),
public.review_request (
  uuid,
  boolean,
  double precision,
  double precision,
  uuid
)
FROM
  public;

GRANT
EXECUTE ON FUNCTION public.request_access (text, text, text),
public.review_request (
  uuid,
  boolean,
  double precision,
  double precision,
  uuid
) TO authenticated;

INSERT INTO
  public.neighborhoods (slug, name)
VALUES
  ('burr-oaks', 'Burr Oaks');

INSERT INTO
  storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
  )
VALUES
  (
    'household-photos',
    'household-photos',
    FALSE,
    2097152,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
  );

CREATE POLICY nc_photo_read ON storage.objects FOR
SELECT
  TO authenticated USING (
    bucket_id = 'household-photos'
    AND nc_private.photo_access (name, FALSE)
  );

CREATE POLICY nc_photo_upload ON storage.objects FOR INSERT TO authenticated
WITH
  CHECK (
    bucket_id = 'household-photos'
    AND nc_private.photo_access (name, TRUE)
  );

CREATE POLICY nc_photo_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'household-photos'
  AND nc_private.photo_access (name, TRUE)
);

COMMIT;
