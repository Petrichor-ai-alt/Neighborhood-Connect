# Google sign-in

Google creates or signs in to a Supabase Auth account. It does not approve neighborhood access,
create a household, or grant an administrator role. Existing email/password sign-in stays available.
No SQL migration, new Edge Function, or Google Maps setting is needed.

## 1. Configure Google Auth Platform

1. In Google Cloud, select the **Neighborhood Directory** project (the intended project for this app).
2. Open **Google Auth Platform**. If prompted, select **Get started**.
3. Set the app name to **Neighborhood Connect** and choose your own support/contact email.
4. Choose **External** for the audience so neighbors can use personal Google accounts.
5. While testing, add your Google account under **Audience → Test users**. Add other testers as needed.
6. Under **Data Access**, use only `openid`, `userinfo.email`, and `userinfo.profile`.
   Do not request Gmail, Contacts, Drive, or Maps permissions.
7. Open **Clients → Create client**, and choose **Web application**.
8. Name it **Neighborhood Connect Website Sign-in**.
9. Set **Authorized JavaScript origins** to:

   ```text
   https://petrichor-ai-alt.github.io
   ```

10. Set **Authorized redirect URIs** to this Supabase callback (not the GitHub Pages URL):

    ```text
    https://xfkfkxhcgcbufwsobjsf.supabase.co/auth/v1/callback
    ```

11. Create the client. Keep the **Client ID** and **Client secret** for the next step.
    These are OAuth credentials, separate from Maps API keys and the geocoding service account.

## 2. Enable Google in Supabase

1. Open your Neighborhood Connect Supabase project.
2. Open **Authentication → Sign In / Providers → Google** (some dashboard versions label this Providers).
3. Enable Google, paste the Client ID and Client secret, and save.
4. Leave nonce checking enabled and do not allow accounts without an email address.
5. Under **Authentication → URL Configuration**, set **Site URL** to:

   ```text
   https://petrichor-ai-alt.github.io/Neighborhood-Connect/
   ```

6. Add the same exact URL to **Redirect URLs** if it is not already present.
7. Keep the Client secret in Supabase only. Do not paste it into GitHub, config.js, or chat.

## 3. Test before inviting neighbors

1. Open the website and select **Continue with Google**. Choose a Google account.
2. For an existing resident, choose the same verified email used by their current account.
   Supabase links matching verified email identities; household/profile access remains tied to the same user ID.
   A different email can create a separate account. This version does not offer manual linking of different emails.
3. A genuinely new account must still request resident access or accept a valid household invitation.
   Check that it cannot read the directory, map, calendar, or discussions before approval.
4. Check Account settings: sign-in methods should show Google. Contact information remains separate.
5. Test email/password sign-in too. Canceling Google's screen should return with a retry message.
6. Before neighborhood rollout, review Google's **Audience → Publishing status** and publish the OAuth app
   for production. Follow any branding/domain verification prompts Google requires. Testing-mode access is limited.

Google's consent screen may show the Supabase project hostname. A custom authentication domain is optional;
it is not required to test this integration.

## Google-created accounts and passwords

Google users never enter their Google password into Neighborhood Connect.
They can use **Account settings → Password** to set an optional Neighborhood Connect password.
Supabase supports adding email/password authentication to an OAuth account this way.
A linked email/password user continues to verify their existing app password before changing it.

Google-only accounts manage their Google email with Google. They can change their directory contact email
independently in Contact information. Their account settings do not offer an app email-change form until
an email/password identity is available.

Account deletion still requires a Neighborhood Connect password through the existing delete-account worker.
Google users who have not set one are directed to the Password page first. This release does not weaken
the deletion checks or change the deployed deletion worker.

Household invitation codes already persist in session storage across the Google redirect. No invitation codes,
user records, access tokens, or OAuth secrets are added to redirect URLs by this implementation.

## Reference

- https://supabase.com/docs/guides/auth/social-login/auth-google
- https://supabase.com/docs/guides/auth/auth-identity-linking
- https://developers.google.com/identity/branding-guidelines
