# Neighborhood Connect

Private resident directory for Burr Oaks, Naperville, Illinois. Static HTML/CSS/JavaScript on GitHub Pages, Supabase Auth/Postgres/Storage, Google Maps JavaScript API. No build or package installation required. Additional neighborhoods are separated by neighborhood membership in the database.

## Setup in order

1. **Supabase → SQL Editor → New query:** paste the complete contents of `supabase/setup.sql` and run it once. This creates the original tables, permissions, approval functions, and household photo bucket. Next run `supabase/migrations/002-household-members.sql` to enable individual member profiles and optional logins. The script is transactional and intended for a fresh project; don't rerun it after a successful run.
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
- Approved: view their neighborhood's households, individual member profiles, and private photos. A person with their own login edits their own profile.
- Household manager: edit the shared household profile/photos, add and edit people without logins, create email-bound invitations, and manage household login access. This role does not grant neighborhood administration. The first account in a household is its manager.
- Administrator: review only requests in their own neighborhood, approve or reject, and attach residents to a verified household. Approval and role changes cannot be performed through direct client table updates.
- Household address, coordinates, neighborhood, IDs, membership, and roles cannot be changed by resident profile updates. Dashboard administrators can maintain these through SQL.
- Revocation: remove the user's membership in the dashboard. Subsequent database/storage requests fail; existing signed photo URLs expire within five minutes. Previously viewed or downloaded information cannot be recalled.

Photos are stored in a private bucket as `<household UUID>/<unique filename>.jpg`. Reads require membership in the same neighborhood; writes require household manager access. JPEG/PNG/WebP inputs are resized to 1200 px and re-encoded as JPEG, removing original image metadata. Storage accepts those MIME types with a 2 MB per-file cap. The UI limits the gallery to five photos; this count is a convenience limit, not a server-enforced quota. Supabase storage/transfer quotas still apply. The earliest uploaded photo is the main photo; delete/re-upload to change its order. Signed URLs last five minutes; reload a profile if images expire.

## Configuration and growth

The Supabase publishable key and website-restricted Maps key in `config.js` are browser-visible by design. Never place database passwords, Supabase secret keys or service-role keys in the repository. RLS protects data; key visibility does not grant resident privileges.

To add a neighborhood later, add a neighborhoods row, configure its branding/map center in the frontend, and bootstrap its administrator. Database isolation is implemented now; a neighborhood picker, self-service branding editor, and boundary-drawing interface are future features. The current frontend opens Burr Oaks only.

## Verification limits

JavaScript syntax and signed-out behavior can be checked locally. The SQL must still be run in the user's Supabase project and the deployed app must be tested with real accounts. No schema changes have been applied remotely by the build. Google Maps, photo policies, email delivery, and administrator bootstrapping require the setup above before residents can use the directory.

## Household members upgrade (existing project)

Run **only** `supabase/migrations/002-household-members.sql` in Supabase SQL Editor, then reload the website. Do not rerun the original `setup.sql`. The migration is transactional and safe to repeat. It preserves household fields/photos and creates a personal profile for each existing household account, using its approved request name where available. It does not guess individual names from the old residents summary. Existing household managers are preserved on repeats; a household without a manager gets one, favoring its neighborhood administrator.

- **My household → Add member:** create a name, bio, interests, optional contact details, and a private profile photo. No account or email address is required. The household account can manage these unlinked people.
- Open a household in the directory to see its member cards. Open a member card to view that person's profile. Member names and interests are searchable through the household directory.
- **Give own login:** a manager enters the person's login email and creates an invitation link/code. Send it yourself; the app does not send email. It expires after seven days, and a replacement invitation invalidates the previous one.
- The recipient signs in or creates an account using that email, confirms it, then accepts the invitation. If confirmation opens another tab, reopen the invitation link or paste the code in the Join your household panel. It claims the existing profile, creates resident membership for the same household, and creates no duplicate household or person. Users already linked to a household in that neighborhood cannot accept another invitation.
- **My profile:** each linked person edits only their own personal information. Managers edit their own profile and people without logins; they do not edit other linked people's personal details.
- **Make manager / Make member:** household managers can share management without granting neighborhood administrator powers. The last manager cannot be demoted.
- **Remove login access:** removes neighborhood membership and unlinks the account while keeping the profile. A manager cannot remove their own login or an administrator's login through this control. The person becomes manageable through the household account again.
- **Delete profile:** applies to people without logins only. Household data remains. Contact information is optional and separate from the private invitation email.

`household_members` stores people; `memberships` stores approved account access and the separate neighborhood/household roles. Invitation tokens are stored hashed in the private schema, bound to a verified email, single-use, and require an authorized household manager at acceptance. Member identity, account links, and roles have no direct client write privileges; guarded RPCs handle changes. Member photos use a separate private `member-photos` bucket with the same 2 MB file cap.

Before the migration runs, the frontend falls back to the original household-only features. This repository cannot apply SQL to the user's Supabase project. After applying it, test a household manager, a separately signed-in member, an unapproved account, and a different-neighborhood account against the live Supabase policies before invitations begin.

## Automated checks

Run `cd tests`, `npm ci`, then `npm test` (test dependencies only; the website needs no build). The embedded PostgreSQL checks execute the original schema and migration twice, preserve legacy data, and exercise manager/member permissions, neighborhood isolation, guarded account linking, single-use/replaced/canceled invitations, photo permissions, revocation, and approvals. DOM-based frontend checks cover signed-out privacy, the pre-migration fallback, manager/member controls, member creation, household/member navigation, escaping, and member search. These do not replace live Supabase/Auth/Storage and visual browser verification.

## Google Street View house images

After the members upgrade, run `supabase/migrations/003-household-photo-preference.sql` in Supabase SQL Editor. Enable **Street View Static API** in the Google Cloud project and add that API to the existing browser key's allowed APIs, retaining Maps JavaScript API and the website restriction. Billing must be enabled. Google image requests are billed separately from interactive map loads; inspect the current Static Street View pricing and quotas in Google Cloud.

A shared `householdPhoto()` selector applies everywhere: automatic mode uses the first uploaded photo, otherwise a Google Street View image requested using the stored household address. The image loads directly from Google, lazily, with `source=outdoor` and `return_error_code=true`; no Google image is uploaded or cached by our application. Missing/unauthorized images fall back to household initials and are not retried repeatedly in the session. Uploaded photos still use Supabase signed URLs. Google images preserve the full frame and have visible attribution; they are never cropped into the circular household avatar. Individual profiles retain their own photos/initials.

**My household → Household photos → Main house image** offers automatic uploaded-photo priority, an explicit Street View choice, or no house image. Only a household manager can persist this preference. Uploading a photo switches back to automatic mode. Choosing no house image hides the public-to-neighbors house photo/gallery, while the manager can still maintain existing uploads. Preference changes do not delete stored uploads or change their storage permissions. Reload after enabling Google's API if it was unavailable earlier. Google images may be outdated or show the wrong house; a resident can replace them with an upload or hide them. No camera-angle adjustment interface has been added.

The feature stays disabled until the photo-preference database column exists. Public Privacy and Terms pages are linked in the footer and describe the Google imagery integration. Tests cover photo source priority, explicit choices, failure fallback, attribution markup, pre-migration behavior, and manager-only preference writes. Visual rendering and live Google API authorization still require checking on the deployed site.

## Readable code and housekeeping

Before each change, refresh from the latest GitHub `main` commit so direct user edits are preserved. `AGENTS.md` records this rule and requires a guarded update before publishing.

Formatter dependencies are development-only. Run `npm ci` once, then `npm run format` to format source files, or `npm run format:check` to check formatting. `.editorconfig` sets two-space indentation and LF line endings. SQL uses the PostgreSQL formatter. The website continues to serve directly through GitHub Pages without a build step.

## Automatic address locations

Run `supabase/migrations/004-address-geocoding.sql` after the earlier upgrades. It enables Supabase `pg_cron` and schedules hourly deletion of expired Google coordinates. If the extension cannot be enabled, the transaction fails and the website retains its old manual-coordinate workflow; resolve Cron availability before retrying. Enable **Geocoding API** in the same Google project and add it to the existing website-restricted key's allowed APIs, retaining Maps JavaScript API and Street View Static API. No server secret is added to the repository.

After submitting a resident request, the browser automatically looks up the entered street address. A successful, complete house-level match is stored as a proposed location for that request. Partial, ambiguous, coarse, missing, or distant results do not create a pin; the access request still succeeds and the administrator can retry or use manual coordinates. The configured map center provides a coarse proximity guard (±0.04 degrees); it is not the neighborhood boundary.

Resident approvals load the proposed coordinates and offer **Review proposed pin in Google Maps**, **Look up address**, and manual entry. An administrator confirms the location and neighborhood eligibility before approval. Selecting an existing household reuses its existing location and discards the request candidate. Google-derived approved coordinates reside only in `geocoded_locations`, separate from permanent/manual household latitude and longitude fields.

Google coordinates expire after 29 days, giving the hourly cleanup a margin within the 30-day caching allowance. RLS hides expired cache rows immediately, and the client omits stale/missing pins. Administrator visits remain a fallback for missing or nearly expired Google locations. Migrations 005 and 006 add an independent OAuth scheduled refresh at day 25. Regular residents cannot write shared map positions; household managers without neighborhood administrator access cannot refresh the shared cache. If Google remains unavailable through expiration, expired pins stay absent while household profiles remain visible. Existing manually entered household coordinates are preserved.

The embedded PostgreSQL tests validate cache privacy, approval/refresh permissions, migration repeatability, expiry, deletion, and renewal. They call cleanup directly because the local test runtime has no `pg_cron`; the actual Supabase scheduled job and live Google API authorization must be checked after activation. Browser DOM tests cover address-match validation, location expiry, proposed-pin controls, and existing-household selection. No live Supabase database changes are applied by publishing the website.

## Background location refresh

`supabase/migrations/005-background-geocode-refresh.sql` adds an hourly database job that refreshes Google household locations once they reach 25 days old. Successful lookups reset the 29-day expiry. Network/API errors retain the still-valid coordinates and retry with a one-to-six-hour backoff. Cleanup remains the safety net for a prolonged outage; old coordinates are never extended without a successful new lookup. No website visit is required. Manual coordinates and pending resident requests are untouched. Migration `006-oauth-geocode-refresh.sql` replaces its API-key worker with a service-account OAuth Edge Function. See `supabase/background-refresh.md` for activation, secret setup, and testing.

## Private account settings

Account Settings is separate from the neighbor-visible personal and household profiles. It shows the current login, email verification and neighborhood/household roles; supports confirmed login-email changes, password changes/reset emails, local/global sign-out, individual contact privacy and guarded account deletion. Run migration `007-account-settings.sql` and deploy the `delete-account` Edge Function as described in [the activation guide](supabase/account-settings.md). Existing contact visibility is preserved, and hidden personal contact values are stored only in the private schema. Account deletion keeps the household and requires another manager/administrator where applicable.
