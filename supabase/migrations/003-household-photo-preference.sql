-- Run 002-household-members.sql first, then this file. Safe to repeat.
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
  RAISE EXCEPTION 'Run 002-household-members.sql before this photo upgrade';
END IF;
END
$$;

ALTER TABLE public.households
ADD COLUMN IF NOT EXISTS photo_preference text NOT NULL DEFAULT 'auto' CHECK (
  photo_preference IN ('auto', 'streetview', 'none')
);

-- The existing manager-only household RLS policy also applies to this column.
GRANT
UPDATE (photo_preference) ON public.households TO authenticated;

NOTIFY pgrst,
'reload schema';

COMMIT;
