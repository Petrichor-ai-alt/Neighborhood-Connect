# Activate Account Settings

The website adds **Account settings** at the bottom of the sidebar, above Sign out. It is separate from My Profile and My Household, and is available to signed-in people awaiting resident approval too.

## 1. Apply the database update

1. Open your Supabase project → **SQL Editor → New query**.
2. Open [`migrations/007-account-settings.sql`](migrations/007-account-settings.sql) in GitHub and copy the entire file.
3. Paste it into SQL Editor and click **Run**. It requires household-members migration 002 and is safe to repeat. Do not rerun `setup.sql`.
4. Reload the website and open **Account settings**.

Login email/password changes, reset emails, and session sign-out use Supabase Auth and already work without migration 007. Contact privacy and deletion safeguards require this migration. Until it is applied, those controls display an activation message rather than trying an unsafe fallback.

Existing individual contact sharing is preserved. Hiding email or phone moves the visible directory value to an empty string; the actual value and sharing preferences remain in the private schema. Directory queries cannot retrieve hidden values. Saving a profile or photo through the old editor preserves hidden contacts. New profiles default to sharing the optional contact details entered in My Profile; users can change that in Account Settings. Login email never populates the directory email automatically. Household phone/email remain shared and are managed separately in My Household.

## 2. Deploy account deletion

1. In Supabase open **Edge Functions → create a function using the editor**.
2. Name it **`delete-account`**.
3. Paste the complete contents of [`functions/delete-account/index.ts`](functions/delete-account/index.ts) into `index.ts` and deploy.
4. Disable **Verify JWT** for this function only. The function independently validates the signed-in user's bearer token with Supabase Auth, then verifies the current password. This supports the existing browser client and publishable API key without exposing a privileged key.
5. The allowed website origin defaults to `https://petrichor-ai-alt.github.io`. If the website later moves, set `NC_SITE_ORIGIN` in Edge Function Secrets to the new origin (scheme plus hostname, with no path or trailing slash).

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` automatically. Do not copy service-role credentials into the website. No new Google credentials are needed.

CLI alternative:

```sh
supabase functions deploy delete-account --project-ref xfkfkxhcgcbufwsobjsf --no-verify-jwt
```

Deletion requires the current password, typing DELETE, and a final confirmation. The server derives the account ID from the verified token, not the request body. A database trigger checks household/administrator handoff again at the actual Auth deletion. The last household manager must promote another linked login in My Household first; the last neighborhood administrator must arrange another administrator first. These checks apply across all neighborhoods associated with the account.

Uploaded files owned by the account are removed through the Storage API, including shared household photos that account uploaded. Individual profiles and associated private contacts are deleted transactionally with the Auth user; resident requests, memberships and invitations follow their foreign-key deletion rules. The household record, manual position, Google location cache and other household members remain. Previously downloaded information cannot be recalled. If photo removal succeeds but Auth deletion fails, the login remains and the UI reports that some photos may already be removed; retry after resolving the blocker.

## 3. Check authentication email settings

Under **Authentication → URL Configuration**, make sure the Site URL and allowed redirect include:

```text
https://petrichor-ai-alt.github.io/Neighborhood-Connect/
```

Keep secure email-change confirmation enabled. The confirmation instructions may require both the old and new inbox, depending on your Auth configuration. Default Supabase email delivery has testing restrictions; custom SMTP is needed for dependable delivery to neighbors. An email-send failure is shown and is not treated as a successful email change.

## 4. Verify

- Open Account settings: check the login email, verified status, household and role. My Profile should still contain the directory-facing information.
- Hide an individual phone/email, save, then inspect the profile from another approved resident account. The hidden details should be absent. Show them again to restore visibility. Verify shared household contact details separately.
- Save My Profile or change its photo while contacts are hidden; they must stay hidden.
- Change the login email using test inboxes. Confirm the email instructions and check that the directory contact email stays unchanged.
- Change the password, then sign out and sign in with the new password. Test the reset link separately.
- Use two sessions to test **Sign out all devices**. Refresh tokens are revoked; already issued access tokens may remain usable until expiry.
- Test deletion only on a disposable account with another household manager and another administrator where applicable. Verify that the household and other members remain. Do not delete your sole administrator account to test this feature.

Automated local checks cover privacy permissions, migration repeatability, handoff guards, household preservation, frontend routing/form validation, server identity/password checks, and existing application behavior. Live email delivery and Supabase function deployment must be verified in your project.
