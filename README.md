# Neighborhood Connect

Private resident directory for Burr Oaks, Naperville, Illinois. Static HTML/CSS/JavaScript on GitHub Pages, Supabase Auth/Postgres/Storage, Google Maps JavaScript API. No build or package installation required. Additional neighborhoods are separated by neighborhood membership in the database.

## Setup in order

1. **Supabase → SQL Editor → New query:** paste the complete contents of `supabase/setup.sql` and run it once. This creates tables, explicit privileges, RLS policies, two approval functions, and a private photo bucket. The script is transactional and intended for a fresh project; don't rerun it after a successful run.
2. **GitHub → Settings → Pages:** select **Deploy from a branch**, select the default branch and **/ (root)**, and Save. The expected URL is https://petrichor-ai-alt.github.io/Neighborhood-Connect/ . Wait for GitHub Pages to finish deployment. `.nojekyll` prevents Jekyll processing.
3. **Supabase → Authentication → URL Configuration:** set Site URL to that exact website URL and add the same URL to Redirect URLs. Use the trailing slash. Email/password authentication should be enabled; keep email confirmation enabled.
4. **Supabase email delivery:** configure a custom SMTP provider before inviting residents. Supabase's built-in email service is for testing and restricts recipients to project team members. It is not sufficient for neighborhood signups or password resets. Select a provider with a suitable free tier and verify its sender/domain requirements. No email provider has been connected by this repository.
5. **Google Cloud:** enable billing and the Maps JavaScript API. Restrict the provided key to the Maps JavaScript API and website `https://petrichor-ai-alt.github.io/*`. The map only loads after approved sign-in. `DEMO_MAP_ID` works for initial testing; create a JavaScript map ID and replace `mapId` in `config.js` for the production map. `center` is an approximate neighborhood-area center; it is not an exact boundary.
6. Open the website, create your own account, and confirm your email. Do not confuse a Supabase dashboard account with a website resident account.
7. Open `supabase/bootstrap-admin.sql`, replace the email, address, display name, and null latitude/longitude with your verified home coordinates. Run the edited script once in Supabase SQL Editor. Its guard prevents creating a home pin before coordinates are supplied. Sign out and sign back into the website. You will now see **Resident approvals**.
8. Test with a second resident account before inviting the neighborhood. A pending account must not see household records or photos. Verify approval, profile changes, photo upload/delete, sign-out, and password recovery on the deployed website. Check denied direct API access and isolation between neighborhoods too.

## Burr Oaks scope

Start with Indiana Ave, Pin Oak Ln, local College Rd, Hemlock Ln, and Blackthorne Ln in the user-supplied screenshot. Include only College Rd and Indiana Ave addresses within that screenshot, not the nearby major road named College Rd. An exact polygon and address inventory have **not** been inferred from the screenshot. Administrators verify each address manually. Add coordinates by locating each home in Google Maps, not by guessing. If a second resident belongs to an existing home, select that household during approval.

## Permissions

- Public: neighborhood name/slug and website files only.
- Signed in, unapproved: submit one request per neighborhood and see their own request status.
- Approved: view their neighborhood's households and photos; edit only their own household's profile and upload/delete its photos.
- Administrator: review only requests in their own neighborhood, approve or reject, and attach residents to a verified household. Approval and role changes cannot be performed through direct client table updates.
- Household address, coordinates, neighborhood, IDs, membership, and roles cannot be changed by resident profile updates. Dashboard administrators can maintain these through SQL.
- Revocation: remove the user's membership in the dashboard. Subsequent database/storage requests fail; existing signed photo URLs expire within five minutes. Previously viewed or downloaded information cannot be recalled.

Photos are stored in a private bucket as `<household UUID>/<unique filename>.jpg`. Reads require membership in the same neighborhood; writes require membership in that household. JPEG/PNG/WebP inputs are resized to 1200 px and re-encoded as JPEG, removing original image metadata. Storage accepts those MIME types with a 2 MB per-file cap. The UI limits the gallery to five photos; this count is a convenience limit, not a server-enforced quota. Supabase storage/transfer quotas still apply. The earliest uploaded photo is the main photo; delete/re-upload to change its order. Signed URLs last five minutes; reload a profile if images expire.

## Configuration and growth

The Supabase publishable key and website-restricted Maps key in `config.js` are browser-visible by design. Never place database passwords, Supabase secret keys or service-role keys in the repository. RLS protects data; key visibility does not grant resident privileges.

To add a neighborhood later, add a neighborhoods row, configure its branding/map center in the frontend, and bootstrap its administrator. Database isolation is implemented now; a neighborhood picker, self-service branding editor, and boundary-drawing interface are future features. The current frontend opens Burr Oaks only.

## Verification limits

JavaScript syntax and signed-out behavior can be checked locally. The SQL must still be run in the user's Supabase project and the deployed app must be tested with real accounts. No schema changes have been applied remotely by the build. Google Maps, photo policies, email delivery, and administrator bootstrapping require the setup above before residents can use the directory.
