-- After creating your account in the website and verifying your email,
-- replace all placeholders below. Run this in SQL Editor, not the website.
-- A verified address and its coordinates are required; do not use guessed home pins.
DO $$
DECLARE
  u uuid;
  n uuid;
  h uuid;
  verified_lat double precision := NULL;
  verified_lng double precision := NULL;
BEGIN
  -- Replace null above with the verified latitude and longitude of your home.
  IF verified_lat IS NULL OR verified_lng IS NULL THEN
    RAISE EXCEPTION 'Enter verified household coordinates before running';
  END IF;
  SELECT
    id INTO u
  FROM
    auth.users
  WHERE
    lower(email) = lower('YOUR_ACCOUNT_EMAIL');
  IF u IS NULL THEN
    RAISE EXCEPTION 'Create your website account first';
  END IF;
  SELECT
    id INTO n
  FROM
    public.neighborhoods
  WHERE
    slug = 'burr-oaks';
  INSERT INTO public.households (neighborhood_id, address, display_name, latitude, longitude)
    VALUES (n, 'YOUR_FULL_ADDRESS', 'YOUR_HOUSEHOLD_NAME', verified_lat, verified_lng)
  RETURNING
    id INTO h;
  INSERT INTO public.memberships (user_id, neighborhood_id, household_id, role)
    VALUES (u, n, h, 'admin');
  UPDATE
    public.access_requests
  SET
    status = 'approved'
  WHERE
    user_id = u
    AND neighborhood_id = n;
END
$$;
