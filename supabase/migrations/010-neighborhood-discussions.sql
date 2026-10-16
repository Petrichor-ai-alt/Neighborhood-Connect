-- Run after 002-household-members.sql. Private discussions; no email or public access.
BEGIN;

CREATE TABLE IF NOT EXISTS public.discussion_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_id uuid NOT NULL REFERENCES public.neighborhoods (id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  author_name text NOT NULL,
  title text NOT NULL CHECK (
    length(trim(title)) BETWEEN 1 AND 120
    AND title ~ '[^[:space:]]'
  ),
  body text NOT NULL CHECK (
    length(trim(body)) BETWEEN 1 AND 5000
    AND body ~ '[^[:space:]]'
  ),
  category text NOT NULL DEFAULT 'general' CHECK (
    category IN (
      'general',
      'recommendations',
      'questions',
      'ideas'
    )
  ),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  reply_count integer NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.discussion_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.discussion_threads (id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  author_name text NOT NULL,
  body text NOT NULL CHECK (
    length(trim(body)) BETWEEN 1 AND 3000
    AND body ~ '[^[:space:]]'
  ),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discussions_by_activity ON public.discussion_threads (neighborhood_id, last_activity DESC, id);

CREATE INDEX IF NOT EXISTS replies_by_thread ON public.discussion_replies (thread_id, created_at, id);

ALTER TABLE public.discussion_threads ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.discussion_replies ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discussion_threads,
public.discussion_replies
FROM
  public,
  anon,
  authenticated;

GRANT
SELECT
  ON public.discussion_threads,
  public.discussion_replies TO authenticated;

DROP POLICY IF EXISTS threads_for_neighbors ON public.discussion_threads;

CREATE POLICY threads_for_neighbors ON public.discussion_threads FOR
SELECT
  TO authenticated USING (nc_private.is_member (neighborhood_id));

DROP POLICY IF EXISTS replies_for_neighbors ON public.discussion_replies;

CREATE POLICY replies_for_neighbors ON public.discussion_replies FOR
SELECT
  TO authenticated USING (
    EXISTS (
      SELECT
        1
      FROM
        public.discussion_threads t
      WHERE
        t.id = thread_id
        AND nc_private.is_member (t.neighborhood_id)
    )
  );

CREATE OR REPLACE FUNCTION nc_private.discussion_author (neighborhood uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT coalesce(nullif(trim(p.display_name),''),nullif(trim(h.display_name),''),'A neighbor')
  FROM public.memberships m
  JOIN public.households h ON h.id=m.household_id
  LEFT JOIN public.household_members p ON p.household_id=m.household_id AND p.user_id=m.user_id
  WHERE m.user_id=auth.uid() AND m.neighborhood_id=neighborhood
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION nc_private.discussion_author (uuid)
FROM
  public,
  anon,
  authenticated;

CREATE OR REPLACE FUNCTION public.save_discussion_thread (
  neighborhood uuid,
  thread uuid,
  thread_title text,
  thread_body text,
  thread_category text,
  expected_revision integer DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  existing public.discussion_threads;
  result uuid;
BEGIN
  PERFORM 1 FROM public.memberships m
    WHERE m.user_id=auth.uid() AND m.neighborhood_id=neighborhood FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved neighborhood access required';
  END IF;
  IF thread IS NOT NULL THEN
    SELECT * INTO existing FROM public.discussion_threads t WHERE t.id=thread FOR UPDATE;
    IF existing.id IS NULL OR existing.neighborhood_id IS DISTINCT FROM neighborhood THEN
      RAISE EXCEPTION 'Discussion not found';
    END IF;
    IF existing.author_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Only the author can edit this discussion';
    END IF;
    IF existing.status='closed' THEN
      RAISE EXCEPTION 'This discussion is closed';
    END IF;
    IF existing.revision IS DISTINCT FROM expected_revision THEN
      RAISE EXCEPTION 'This discussion changed. Reload it before editing';
    END IF;
    UPDATE public.discussion_threads SET title=trim(thread_title),body=trim(thread_body),
      category=thread_category,revision=revision+1,updated_at=now(),last_activity=now()
      WHERE id=existing.id;
    RETURN existing.id;
  END IF;
  INSERT INTO public.discussion_threads(neighborhood_id,author_user_id,author_name,title,body,category)
    VALUES(neighborhood,auth.uid(),nc_private.discussion_author(neighborhood),trim(thread_title),trim(thread_body),thread_category)
    RETURNING id INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_discussion_reply (
  thread uuid,
  reply uuid,
  reply_body text,
  expected_revision integer DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  parent public.discussion_threads;
  existing public.discussion_replies;
  result uuid;
  area uuid;
BEGIN
  SELECT t.neighborhood_id INTO area FROM public.discussion_threads t WHERE t.id=thread;
  PERFORM 1 FROM public.memberships m
    WHERE m.user_id=auth.uid() AND m.neighborhood_id=area FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved neighborhood access required';
  END IF;
  SELECT * INTO parent FROM public.discussion_threads t WHERE t.id=thread FOR UPDATE;
  IF parent.id IS NULL THEN
    RAISE EXCEPTION 'Discussion not found';
  END IF;
  IF parent.status='closed' THEN
    RAISE EXCEPTION 'This discussion is closed';
  END IF;
  IF reply IS NOT NULL THEN
    SELECT * INTO existing FROM public.discussion_replies r WHERE r.id=reply FOR UPDATE;
    IF existing.id IS NULL OR existing.thread_id IS DISTINCT FROM thread THEN
      RAISE EXCEPTION 'Reply not found';
    END IF;
    IF existing.author_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Only the author can edit this reply';
    END IF;
    IF existing.revision IS DISTINCT FROM expected_revision THEN
      RAISE EXCEPTION 'This reply changed. Reload it before editing';
    END IF;
    UPDATE public.discussion_replies SET body=trim(reply_body),revision=revision+1,updated_at=now()
      WHERE id=existing.id;
    RETURN existing.id;
  END IF;
  INSERT INTO public.discussion_replies(thread_id,author_user_id,author_name,body)
    VALUES(thread,auth.uid(),nc_private.discussion_author(area),trim(reply_body))
    RETURNING id INTO result;
  UPDATE public.discussion_threads SET reply_count=reply_count+1,last_activity=now()
    WHERE id=thread;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.moderate_discussion (
  thread uuid,
  action text,
  expected_revision integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  existing public.discussion_threads;
  area uuid;
BEGIN
  SELECT t.neighborhood_id INTO area FROM public.discussion_threads t WHERE t.id=thread;
  PERFORM 1 FROM public.memberships m
    WHERE m.user_id=auth.uid() AND m.neighborhood_id=area FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved neighborhood access required';
  END IF;
  SELECT * INTO existing FROM public.discussion_threads t WHERE t.id=thread FOR UPDATE;
  IF existing.id IS NULL THEN
    RAISE EXCEPTION 'Discussion not found';
  END IF;
  IF existing.revision IS DISTINCT FROM expected_revision THEN
    RAISE EXCEPTION 'This discussion changed. Reload it before continuing';
  END IF;
  IF action='remove' THEN
    IF existing.author_user_id IS DISTINCT FROM auth.uid() AND NOT nc_private.is_admin(area) THEN
      RAISE EXCEPTION 'Only the author or an administrator can remove this discussion';
    END IF;
    DELETE FROM public.discussion_threads WHERE id=thread;
  ELSIF action IN ('close','reopen') THEN
    IF NOT nc_private.is_admin(area) THEN
      RAISE EXCEPTION 'Only an administrator can close or reopen discussions';
    END IF;
    UPDATE public.discussion_threads SET status=CASE WHEN action='close' THEN 'closed' ELSE 'open' END,
      revision=revision+1,updated_at=now() WHERE id=thread;
  ELSE
    RAISE EXCEPTION 'Unknown discussion action';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_discussion_reply (reply uuid, expected_revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  existing public.discussion_replies;
  parent uuid;
  area uuid;
BEGIN
  SELECT r.thread_id,t.neighborhood_id INTO parent,area FROM public.discussion_replies r
    JOIN public.discussion_threads t ON t.id=r.thread_id WHERE r.id=reply;
  PERFORM 1 FROM public.memberships m
    WHERE m.user_id=auth.uid() AND m.neighborhood_id=area FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved neighborhood access required';
  END IF;
  PERFORM 1 FROM public.discussion_threads t WHERE t.id=parent FOR UPDATE;
  SELECT * INTO existing FROM public.discussion_replies r WHERE r.id=reply FOR UPDATE;
  IF existing.id IS NULL THEN
    RAISE EXCEPTION 'Reply not found';
  END IF;
  IF existing.author_user_id IS DISTINCT FROM auth.uid() AND NOT nc_private.is_admin(area) THEN
    RAISE EXCEPTION 'Only the author or an administrator can remove this reply';
  END IF;
  IF existing.revision IS DISTINCT FROM expected_revision THEN
    RAISE EXCEPTION 'This reply changed. Reload it before continuing';
  END IF;
  DELETE FROM public.discussion_replies WHERE id=reply;
  UPDATE public.discussion_threads SET reply_count=greatest(0,reply_count-1),
    last_activity=greatest(updated_at,coalesce((SELECT max(r.created_at) FROM public.discussion_replies r WHERE r.thread_id=parent),created_at))
    WHERE id=parent;
END;
$$;

REVOKE ALL ON FUNCTION public.save_discussion_thread (uuid, uuid, text, text, text, integer),
public.save_discussion_reply (uuid, uuid, text, integer),
public.moderate_discussion (uuid, text, integer),
public.remove_discussion_reply (uuid, integer)
FROM
  public,
  anon;

GRANT
EXECUTE ON FUNCTION public.save_discussion_thread (uuid, uuid, text, text, text, integer),
public.save_discussion_reply (uuid, uuid, text, integer),
public.moderate_discussion (uuid, text, integer),
public.remove_discussion_reply (uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION nc_private.anonymize_discussion_author () RETURNS trigger LANGUAGE plpgsql
SET
  search_path = '' AS $$
BEGIN
  IF OLD.author_user_id IS NOT NULL AND NEW.author_user_id IS NULL THEN
    NEW.author_name := 'Former neighbor';
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION nc_private.anonymize_discussion_author ()
FROM
  public,
  anon,
  authenticated;

DROP TRIGGER IF EXISTS discussion_author_deleted ON public.discussion_threads;

CREATE TRIGGER discussion_author_deleted
BEFORE UPDATE OF author_user_id ON public.discussion_threads FOR EACH ROW
EXECUTE FUNCTION nc_private.anonymize_discussion_author ();

DROP TRIGGER IF EXISTS reply_author_deleted ON public.discussion_replies;

CREATE TRIGGER reply_author_deleted
BEFORE UPDATE OF author_user_id ON public.discussion_replies FOR EACH ROW
EXECUTE FUNCTION nc_private.anonymize_discussion_author ();

NOTIFY pgrst,
'reload schema';

COMMIT;
