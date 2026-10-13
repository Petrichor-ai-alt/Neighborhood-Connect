-- Run migrations 002 and 003 first. Safe to repeat; existing contact sharing is preserved.
BEGIN;

CREATE TABLE IF NOT EXISTS nc_private.person_contacts (
  person_id uuid PRIMARY KEY REFERENCES public.household_members (id) ON DELETE CASCADE,
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 200),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  share_email boolean NOT NULL DEFAULT TRUE,
  share_phone boolean NOT NULL DEFAULT TRUE
);

ALTER TABLE nc_private.person_contacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON nc_private.person_contacts
FROM
  public,
  anon,
  authenticated;

INSERT INTO
  nc_private.person_contacts (person_id, email, phone)
SELECT
  id,
  email,
  phone
FROM
  public.household_members
ON CONFLICT (person_id) DO NOTHING;

CREATE OR REPLACE FUNCTION nc_private.write_household_member (
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

REVOKE ALL ON FUNCTION nc_private.write_household_member (uuid, uuid, text, text, text, text, text, text)
FROM
  public,
  anon,
  authenticated;

-- Keep the existing profile-editor API; hidden contacts never return to public columns.
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
  prefs nc_private.person_contacts;
  result uuid;
BEGIN
  PERFORM 1 FROM public.households WHERE id=household FOR UPDATE;
  SELECT * INTO prefs FROM nc_private.person_contacts WHERE person_id=person;
  result:=nc_private.write_household_member(household,person,person_name,person_bio,person_interests,
    CASE WHEN prefs.share_email=false THEN '' ELSE contact_email END,
    CASE WHEN prefs.share_phone=false THEN '' ELSE contact_phone END,photo);
  INSERT INTO nc_private.person_contacts(person_id,email,phone,share_email,share_phone)
    VALUES(result,CASE WHEN prefs.share_email=false THEN prefs.email ELSE trim(contact_email) END,
      CASE WHEN prefs.share_phone=false THEN prefs.phone ELSE trim(contact_phone) END,
      coalesce(prefs.share_email,true),coalesce(prefs.share_phone,true))
    ON CONFLICT(person_id) DO UPDATE SET email=excluded.email,phone=excluded.phone;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.save_household_member (uuid, uuid, text, text, text, text, text, text)
FROM
  public,
  anon;

GRANT
EXECUTE ON FUNCTION public.save_household_member (uuid, uuid, text, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_account_contacts (
  neighborhood_slug text,
  contact_email text,
  contact_phone text,
  show_email boolean,
  show_phone boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  p public.household_members;
BEGIN
  SELECT person.* INTO p FROM public.household_members person
  JOIN public.households h ON h.id=person.household_id
  JOIN public.neighborhoods n ON n.id=h.neighborhood_id
  JOIN public.memberships m ON m.household_id=h.id AND m.user_id=auth.uid()
  WHERE person.user_id=auth.uid() AND n.slug=neighborhood_slug FOR UPDATE OF person;
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'Your individual profile is not linked';
  END IF;
  IF contact_email IS NULL OR contact_phone IS NULL OR show_email IS NULL OR show_phone IS NULL
    OR length(contact_email)>200 OR length(contact_phone)>40 THEN RAISE EXCEPTION 'Invalid contact details'; END IF;
  IF trim(contact_email)<>'' AND trim(contact_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'Enter a valid contact email'; END IF;
  INSERT INTO nc_private.person_contacts(person_id,email,phone,share_email,share_phone)
  VALUES(p.id,trim(contact_email),trim(contact_phone),show_email,show_phone)
  ON CONFLICT(person_id) DO UPDATE SET email=excluded.email,phone=excluded.phone,share_email=excluded.share_email,share_phone=excluded.share_phone;
  UPDATE public.household_members SET email=CASE WHEN show_email THEN trim(contact_email) ELSE '' END,
    phone=CASE WHEN show_phone THEN trim(contact_phone) ELSE '' END WHERE id=p.id;
END $$;

REVOKE ALL ON FUNCTION public.save_account_contacts (text, text, text, boolean, boolean)
FROM
  public,
  anon;

GRANT
EXECUTE ON FUNCTION public.save_account_contacts (text, text, text, boolean, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION nc_private.account_deletion_blocker (account uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.memberships m WHERE m.user_id=account AND m.role='admin'
    AND NOT EXISTS(SELECT 1 FROM public.memberships other WHERE other.neighborhood_id=m.neighborhood_id AND other.role='admin' AND other.user_id<>account))
  THEN
    RETURN 'You are the last neighborhood administrator. Arrange for another administrator before deleting your account.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.memberships m WHERE m.user_id=account AND m.household_role='manager'
    AND NOT EXISTS(SELECT 1 FROM public.memberships other WHERE other.household_id=m.household_id AND other.household_role='manager' AND other.user_id<>account))
  THEN
    RETURN 'Give another household login manager access in My Household before deleting your account.';
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION nc_private.account_deletion_blocker (uuid)
FROM
  public,
  anon,
  authenticated;

CREATE OR REPLACE FUNCTION public.account_settings (neighborhood_slug text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  contact jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in first';
  END IF;
  SELECT jsonb_build_object(
    'email', coalesce(c.email, p.email),
    'phone', coalesce(c.phone, p.phone),
    'share_email', coalesce(c.share_email, true),
    'share_phone', coalesce(c.share_phone, true)
  ) INTO contact
    FROM public.household_members p LEFT JOIN nc_private.person_contacts c ON c.person_id=p.id
    JOIN public.households h ON h.id=p.household_id JOIN public.neighborhoods n ON n.id=h.neighborhood_id
    JOIN public.memberships m ON m.household_id=h.id AND m.user_id=auth.uid()
    WHERE p.user_id=auth.uid() AND n.slug=neighborhood_slug;
  RETURN jsonb_build_object(
    'contact', contact,
    'deletion_blocker', nc_private.account_deletion_blocker(auth.uid())
  );
END $$;

REVOKE ALL ON FUNCTION public.account_settings (text)
FROM
  public,
  anon;

GRANT
EXECUTE ON FUNCTION public.account_settings (text) TO authenticated;

-- The server gets only this account's objects; clients cannot enumerate ownership.
CREATE OR REPLACE FUNCTION public.account_deletion_plan (account uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  blocker text;
  objects jsonb;
BEGIN
  blocker:=nc_private.account_deletion_blocker(account);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'name',o.name)),'[]'::jsonb) INTO objects
  FROM storage.objects o WHERE coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=account::text;
  RETURN objects;
END $$;

REVOKE ALL ON FUNCTION public.account_deletion_plan (uuid)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON FUNCTION public.account_deletion_plan (uuid) TO service_role;

-- Recheck at the actual Auth deletion, including against concurrent household edits.
CREATE OR REPLACE FUNCTION nc_private.guard_account_deletion () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  blocker text;
BEGIN
  PERFORM 1 FROM public.neighborhoods WHERE id IN(SELECT neighborhood_id FROM public.memberships WHERE user_id=OLD.id) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.households WHERE id IN(SELECT household_id FROM public.memberships WHERE user_id=OLD.id) ORDER BY id FOR UPDATE;
  blocker:=nc_private.account_deletion_blocker(OLD.id);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker;
  END IF;
  DELETE FROM public.household_members WHERE user_id=OLD.id;
  RETURN OLD;
END $$;

REVOKE ALL ON FUNCTION nc_private.guard_account_deletion ()
FROM
  public,
  anon,
  authenticated;

DROP TRIGGER IF EXISTS nc_guard_account_deletion ON auth.users;

CREATE TRIGGER nc_guard_account_deletion
BEFORE DELETE ON auth.users FOR EACH ROW
EXECUTE FUNCTION nc_private.guard_account_deletion ();

COMMIT;
