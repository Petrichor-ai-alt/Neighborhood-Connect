-- Existing projects: run this complete file in Supabase SQL Editor.
-- Fresh projects: run setup.sql first, then this file. Safe to rerun.
BEGIN;

ALTER TABLE public.memberships
ADD COLUMN IF NOT EXISTS household_role text NOT NULL DEFAULT 'member' CHECK (household_role IN ('manager', 'member'));

CREATE TABLE IF NOT EXISTS public.household_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
  bio text NOT NULL DEFAULT '' CHECK (length(bio) <= 1500),
  interests text NOT NULL DEFAULT '' CHECK (length(interests) <= 500),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 200),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  photo_path text NOT NULL DEFAULT '' CHECK (length(photo_path) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, user_id)
);

CREATE INDEX IF NOT EXISTS household_members_household ON public.household_members (household_id);

-- Pick one manager for households that have no manager yet. Preserve existing roles on reruns.
WITH
  first_accounts AS (
    SELECT DISTINCT
      ON (household_id) household_id,
      user_id
    FROM
      public.memberships
    ORDER BY
      household_id,
      (ROLE = 'admin') DESC,
      user_id
  )
UPDATE public.memberships m
SET
  household_role = 'manager'
FROM
  first_accounts f
WHERE
  m.household_id = f.household_id
  AND m.user_id = f.user_id
  AND NOT EXISTS (
    SELECT
      1
    FROM
      public.memberships other
    WHERE
      other.household_id = m.household_id
      AND other.household_role = 'manager'
  );

-- One real person per existing account. Do not guess people from the old residents text.
INSERT INTO
  public.household_members (household_id, user_id, display_name)
SELECT
  m.household_id,
  m.user_id,
  coalesce(
    nullif(trim(r.name), ''),
    nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
    'Household member'
  )
FROM
  public.memberships m
  JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.access_requests r ON r.user_id = m.user_id
  AND r.neighborhood_id = m.neighborhood_id
ON CONFLICT (household_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION nc_private.can_edit (h uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
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
        AND m.household_id = h
        AND m.household_role = 'manager');
$$;

CREATE OR REPLACE FUNCTION nc_private.photo_access (path text, writing boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
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
          OR (m.household_id = h.id
            AND m.household_role = 'manager')));
$$;

CREATE OR REPLACE FUNCTION nc_private.can_edit_person (p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT
    EXISTS (
      SELECT
        1
      FROM
        public.household_members person
        JOIN public.households h ON h.id = person.household_id
      WHERE
        person.id = p
        AND nc_private.is_member (h.neighborhood_id)
        AND (person.user_id = auth.uid ()
          OR (person.user_id IS NULL
            AND nc_private.can_edit (person.household_id))));
$$;

CREATE OR REPLACE FUNCTION nc_private.person_photo_access (path text, writing boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT
    EXISTS (
      SELECT
        1
      FROM
        public.household_members p
        JOIN public.households h ON h.id = p.household_id
      WHERE
        p.id::text = split_part(path, '/', 1)
        AND nc_private.is_member (h.neighborhood_id)
        AND (NOT writing
          OR nc_private.can_edit_person (p.id)));
$$;

REVOKE ALL ON FUNCTION nc_private.can_edit_person (uuid),
nc_private.person_photo_access (text, boolean)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON FUNCTION nc_private.can_edit_person (uuid),
nc_private.person_photo_access (text, boolean) TO authenticated;

ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.household_members
FROM
  anon,
  authenticated;

GRANT
SELECT
  ON public.household_members TO authenticated;

DROP POLICY IF EXISTS member_directory ON public.household_members;

CREATE POLICY member_directory ON public.household_members FOR
SELECT
  TO authenticated USING (
    EXISTS (
      SELECT
        1
      FROM
        public.households h
      WHERE
        h.id = household_id
        AND nc_private.is_member (h.neighborhood_id)
    )
  );

CREATE TABLE IF NOT EXISTS nc_private.member_invites (
  member_id uuid PRIMARY KEY REFERENCES public.household_members (id) ON DELETE CASCADE,
  token_hash bytea UNIQUE NOT NULL,
  target_email text NOT NULL,
  invited_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

REVOKE ALL ON nc_private.member_invites
FROM
  public,
  anon,
  authenticated;

ALTER TABLE nc_private.member_invites ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.save_household_member (
  household uuid,
  person uuid,
  person_name text,
  person_bio text DEFAULT '',
  person_interests text DEFAULT '',
  contact_email text DEFAULT '',
  contact_phone text DEFAULT '',
  photo text DEFAULT ''
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  p public.household_members;
  result uuid;
BEGIN
  PERFORM
    1
  FROM
    public.households
  WHERE
    id = household
  FOR UPDATE;
  IF person IS NULL THEN
    IF NOT nc_private.can_edit (household) THEN
      RAISE EXCEPTION 'Household manager access required';
    END IF;
    IF photo <> '' THEN
      RAISE EXCEPTION 'Save the profile before adding a photo';
    END IF;
    INSERT INTO public.household_members (household_id, display_name, bio, interests, email, phone)
      VALUES (household, trim(person_name), person_bio, person_interests, trim(contact_email), trim(contact_phone))
    RETURNING
      id INTO result;
  ELSE
    SELECT
      * INTO p
    FROM
      public.household_members
    WHERE
      id = person
      AND household_id = household
    FOR UPDATE;
    IF p.id IS NULL OR NOT nc_private.can_edit_person (p.id) THEN
      RAISE EXCEPTION 'You cannot edit this member profile';
    END IF;
    IF photo <> '' AND (split_part(photo, '/', 1) <> p.id::text OR photo LIKE '%..%') THEN
      RAISE EXCEPTION 'Invalid member photo';
    END IF;
    UPDATE
      public.household_members
    SET
      display_name = trim(person_name),
      bio = person_bio,
      interests = person_interests,
      email = trim(contact_email),
      phone = trim(contact_phone),
      photo_path = photo
    WHERE
      id = p.id
    RETURNING
      id INTO result;
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.manage_household_member (person uuid, action text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  p public.household_members;
  m public.memberships;
  h uuid;
BEGIN
  SELECT
    household_id INTO h
  FROM
    public.household_members
  WHERE
    id = person;
  PERFORM
    1
  FROM
    public.households
  WHERE
    id = h
  FOR UPDATE;
  SELECT
    * INTO p
  FROM
    public.household_members
  WHERE
    id = person
  FOR UPDATE;
  IF p.id IS NULL OR NOT nc_private.can_edit (p.household_id) THEN
    RAISE EXCEPTION 'Household manager access required';
  END IF;
  IF action = 'delete' THEN
    IF p.user_id IS NOT NULL THEN
      RAISE EXCEPTION 'Remove login access before deleting this profile';
    END IF;
    DELETE FROM public.household_members
    WHERE id = p.id;
  ELSIF action = 'cancel_invite' THEN
    DELETE FROM nc_private.member_invites
    WHERE member_id = p.id;
  ELSIF action IN ('promote', 'demote', 'remove_login') THEN
    SELECT
      * INTO m
    FROM
      public.memberships
    WHERE
      household_id = p.household_id
      AND user_id = p.user_id
    FOR UPDATE;
    IF m.user_id IS NULL THEN
      RAISE EXCEPTION 'This member has no household login';
    END IF;
    IF action IN ('demote', 'remove_login') AND m.household_role = 'manager' AND (
      SELECT
        count(*)
      FROM
        public.memberships
      WHERE
        household_id = p.household_id AND household_role = 'manager') <= 1 THEN
      RAISE EXCEPTION 'A household must keep at least one manager';
    END IF;
    IF action = 'remove_login' THEN
      IF p.user_id = auth.uid () THEN
        RAISE EXCEPTION 'Ask another manager to remove your login';
      END IF;
      IF m.role = 'admin' THEN
        RAISE EXCEPTION 'Neighborhood administrator access must be removed by a neighborhood administrator first';
      END IF;
      DELETE FROM public.memberships
      WHERE household_id = p.household_id
        AND user_id = p.user_id;
      UPDATE
        public.household_members
      SET
        user_id = NULL
      WHERE
        id = p.id;
      DELETE FROM nc_private.member_invites
      WHERE member_id = p.id
        OR invited_by = p.user_id;
    ELSE
      UPDATE
        public.memberships
      SET
        household_role = CASE WHEN action = 'promote' THEN
          'manager'
        ELSE
          'member'
        END
      WHERE
        household_id = p.household_id
        AND user_id = p.user_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown member action';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invite_household_member (person uuid, login_email text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  p public.household_members;
  token text;
  h uuid;
BEGIN
  SELECT
    household_id INTO h
  FROM
    public.household_members
  WHERE
    id = person;
  PERFORM
    1
  FROM
    public.households
  WHERE
    id = h
  FOR UPDATE;
  SELECT
    * INTO p
  FROM
    public.household_members
  WHERE
    id = person
  FOR UPDATE;
  IF p.id IS NULL OR NOT nc_private.can_edit (p.household_id) THEN
    RAISE EXCEPTION 'Household manager access required';
  END IF;
  IF p.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'This profile already has a login';
  END IF;
  IF length(trim(login_email)) > 200 OR trim(login_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter a valid login email';
  END IF;
  token = replace(gen_random_uuid ()::text, '-', '') || replace(gen_random_uuid ()::text, '-', '');
  INSERT INTO nc_private.member_invites (member_id, token_hash, target_email, invited_by, expires_at)
    VALUES (p.id, sha256 (convert_to(token, 'UTF8')), lower(trim(login_email)), auth.uid (), now() + interval '7 days')
  ON CONFLICT (member_id)
    DO UPDATE SET
      token_hash = excluded.token_hash,
      target_email = excluded.target_email,
      invited_by = excluded.invited_by,
      expires_at = excluded.expires_at;
  RETURN token;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_household_invite (invite_code text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  i nc_private.member_invites;
  p public.household_members;
  h public.households;
  login_email text;
  verified timestamptz;
  target uuid;
BEGIN
  IF auth.uid () IS NULL THEN
    RAISE EXCEPTION 'Sign in first';
  END IF;
  SELECT
    member_id INTO target
  FROM
    nc_private.member_invites
  WHERE
    token_hash = sha256 (convert_to(invite_code, 'UTF8'));
  SELECT
    house.* INTO h
  FROM
    public.households house
    JOIN public.household_members person ON person.household_id = house.id
  WHERE
    person.id = target;
  PERFORM
    1
  FROM
    public.households
  WHERE
    id = h.id
  FOR UPDATE;
  SELECT
    * INTO i
  FROM
    nc_private.member_invites
  WHERE
    member_id = target
    AND token_hash = sha256 (convert_to(invite_code, 'UTF8'))
  FOR UPDATE;
  IF i.member_id IS NULL OR i.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation is invalid or expired';
  END IF;
  IF NOT EXISTS (
    SELECT
      1
    FROM
      public.memberships
    WHERE
      user_id = i.invited_by
      AND household_id = h.id
      AND household_role = 'manager') THEN
  RAISE EXCEPTION 'Invitation no longer authorized';
END IF;
  SELECT
    email,
    email_confirmed_at INTO login_email,
    verified
  FROM
    auth.users
  WHERE
    id = auth.uid ();
  IF verified IS NULL OR lower(login_email) <> i.target_email THEN
    RAISE EXCEPTION 'Sign in with the verified email this invitation was created for';
  END IF;
  SELECT
    * INTO p
  FROM
    public.household_members
  WHERE
    id = i.member_id
  FOR UPDATE;
  IF p.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'This profile already has a login';
  END IF;
  IF EXISTS (
    SELECT
      1
    FROM
      public.memberships
    WHERE
      user_id = auth.uid ()
      AND neighborhood_id = h.neighborhood_id) THEN
  RAISE EXCEPTION 'You already belong to a household in this neighborhood';
END IF;
INSERT INTO public.memberships (user_id, neighborhood_id, household_id, household_role)
  VALUES (auth.uid (), h.neighborhood_id, h.id, 'member');
  UPDATE
    public.household_members
  SET
    user_id = auth.uid ()
  WHERE
    id = p.id;
  UPDATE
    public.access_requests
  SET
    status = 'approved'
  WHERE
    user_id = auth.uid ()
    AND neighborhood_id = h.neighborhood_id;
  DELETE FROM nc_private.member_invites
  WHERE member_id = p.id;
  RETURN h.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.household_login_roles (household uuid) RETURNS TABLE (member_id uuid, household_role text) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT
    p.id,
    m.household_role
  FROM
    public.household_members p
    JOIN public.memberships m ON m.household_id = p.household_id
      AND m.user_id = p.user_id
  WHERE
    p.household_id = household
    AND (nc_private.can_edit (household)
      OR p.user_id = auth.uid ());
$$;

REVOKE ALL ON FUNCTION public.household_login_roles (uuid)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON FUNCTION public.household_login_roles (uuid) TO authenticated;

-- Keep the existing approval signature; create a person with every approved login.
CREATE OR REPLACE FUNCTION public.review_request (
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
  manager boolean;
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
        AND neighborhood_id = r.neighborhood_id
      FOR UPDATE;
      IF h IS NULL THEN
        RAISE EXCEPTION 'Household is not in this neighborhood';
      END IF;
    ELSE
      IF lat IS NULL OR lng IS NULL THEN
        RAISE EXCEPTION 'Verified map coordinates required';
      END IF;
      INSERT INTO public.households (neighborhood_id, address, display_name, latitude, longitude)
        VALUES (r.neighborhood_id, r.address,
          LEFT (r.name || ' household', 100), lat, lng)
      RETURNING
        id INTO h;
    END IF;
    manager = NOT EXISTS (
      SELECT
        1
      FROM
        public.memberships
      WHERE
        household_id = h);
    INSERT INTO public.memberships (user_id, neighborhood_id, household_id, household_role)
      VALUES (r.user_id, r.neighborhood_id, h, CASE WHEN manager THEN
          'manager'
        ELSE
          'member'
        END);
    INSERT INTO public.household_members (household_id, user_id, display_name)
      VALUES (h, r.user_id, r.name);
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

REVOKE ALL ON FUNCTION public.save_household_member (uuid, uuid, text, text, text, text, text, text),
public.manage_household_member (uuid, text),
public.invite_household_member (uuid, text),
public.accept_household_invite (text)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON FUNCTION public.save_household_member (uuid, uuid, text, text, text, text, text, text),
public.manage_household_member (uuid, text),
public.invite_household_member (uuid, text),
public.accept_household_invite (text) TO authenticated;

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
    'member-photos',
    'member-photos',
    FALSE,
    2097152,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
  )
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS nc_member_photo_read ON storage.objects;

DROP POLICY IF EXISTS nc_member_photo_upload ON storage.objects;

DROP POLICY IF EXISTS nc_member_photo_delete ON storage.objects;

CREATE POLICY nc_member_photo_read ON storage.objects FOR
SELECT
  TO authenticated USING (
    bucket_id = 'member-photos'
    AND nc_private.person_photo_access (name, FALSE)
  );

CREATE POLICY nc_member_photo_upload ON storage.objects FOR INSERT TO authenticated
WITH
  CHECK (
    bucket_id = 'member-photos'
    AND nc_private.person_photo_access (name, TRUE)
  );

CREATE POLICY nc_member_photo_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'member-photos'
  AND nc_private.person_photo_access (name, TRUE)
);

NOTIFY pgrst,
'reload schema';

COMMIT;
