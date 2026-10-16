# Neighborhood discussions

## Enable in an existing Supabase project

1. Open **SQL Editor → New query** in the Supabase project used by Neighborhood Connect.
2. Copy the complete contents of [010-neighborhood-discussions.sql](migrations/010-neighborhood-discussions.sql), paste it into SQL Editor, and run it.
3. Refresh Neighborhood Connect and select **Discussions** in the sidebar.

The migration requires the existing households/memberships setup and migration 002.
It is safe to repeat and does not change Google settings, geocoding, schedules, or
existing household/event data. Do not rerun setup.sql. There is no new Edge Function,
API key, email service, or secret to configure. If the migration has not been run, the
page displays a setup message rather than making any private content public.

## Behavior

- Every approved resident can create a discussion and reply to an open thread.
- Categories are General, Recommendations, Questions, and Neighborhood ideas.
- Authors can edit their own open threads/replies and remove their own posts.
- Administrators can close/reopen threads and remove posts. They cannot rewrite
  someone else's text. Closed threads remain readable and reject new replies/edits.
- Removing a thread removes all its replies, after an explicit confirmation.
- The server derives the author from the linked individual profile, falling back to
  the household display name for a login without a linked individual profile.
  Author identity is never supplied by the browser when posting.
- Thread lists show the latest activity first, 20 at a time. Replies are oldest first,
  30 at a time, with load-more controls. Refresh reloads the current conversation/list.
- No rich HTML, image attachments, email notifications, subscriptions, polls, or reactions.
  Typed content is rendered as text; HTML cannot execute.
- Account deletion keeps shared conversation text but removes the account link and
  changes the author label to Former neighbor. It does not rewrite the text itself.

## Security and verification

Tables are protected by row-level security. Only current members of the thread's
neighborhood can read it or its replies. All writes use restricted database functions,
which recheck membership, author/admin permissions, closed status, lengths, categories,
and edit revisions. Membership locks and parent-thread locks serialize changes with
revocation, closure, and deletion. Pending accounts and other neighborhoods have no access.

Local tests cover migration/repeat, RLS, forged edits, author attribution, moderation,
revision conflicts, validation, reply counts, account deletion, membership revocation,
escaped text, pagination, editor dismissal, and stale sign-out responses. These do not
constitute live Supabase verification. After applying the migration, create a test thread,
reply, edit each, and close/reopen the thread from an administrator login.
