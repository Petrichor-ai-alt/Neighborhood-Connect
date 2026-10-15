# Activate the community calendar

The dedicated **Calendar** tab is in the sidebar. The home page is unchanged. It uses FullCalendar Standard with month view and a rolling 90-day upcoming-events list; phones default to the upcoming list. No paid calendar license, Google Calendar API, new API keys, Edge Functions, or scheduled jobs are needed.

## One database step

1. Open your Supabase project → **SQL Editor → New query**.
2. Copy all of [`migrations/008-community-calendar.sql`](migrations/008-community-calendar.sql).
3. Paste it into SQL Editor and click **Run**. Run the whole file, not a highlighted fragment. It requires the existing setup and household-members migration 002. It is safe to repeat and does not alter existing household profiles, locations or account settings. Do not rerun `setup.sql`.
4. Reload Neighborhood Connect and select **Calendar** in the sidebar.
5. Click **Add event**, fill in a title, date/time or all-day dates, location and optional details, then click **Publish event**.

Until the migration is applied, the calendar shows a setup message and leaves Add event disabled. Other parts of the website continue to work.

## What residents can do

Every approved resident can publish immediately, with no review queue. Events are visible only to approved members of the same neighborhood, including cancelled events. The organizer and neighborhood administrators can edit or cancel events. Household management does not grant control of other residents' events. A person who has lost neighborhood access cannot read or edit its events.

Click an event to open its details. **Add to my calendar (.ics)** downloads a single event compatible with Apple Calendar, Outlook, and Google Calendar import. The file is a snapshot, not a live subscription. Later changes or cancellations do not automatically update imported copies. Cancelled events remain visible with a cancelled label; organizers and administrators can correct their details while keeping them cancelled. There is no destructive delete button.

## Dates and timezones

Migration 008 adds `neighborhoods.time_zone`, defaulting to `America/Chicago` for Burr Oaks. Set the proper IANA timezone when creating another neighborhood. Timed events store UTC instants plus the neighborhood timezone; the calendar and editor use the neighborhood timezone even when a resident travels. All-day events store dates, with an exclusive end date; the form asks for the inclusive last day. Multi-day events and events crossing midnight are supported, up to 366 days.

The editor rejects nonexistent times during the spring clock change and ambiguous times during the repeated autumn hour. Choose a time outside the affected hour. Concurrent edits use revision checks so one resident cannot silently overwrite a newer change.

## Privacy and email

Organizer names come from the signed-in person's linked profile. Login email addresses are not published or automatically copied into events. Account deletion preserves shared events and changes the organizer attribution to “Former neighbor”; administrators can manage those events. A location entered into an event is shared with approved neighbors, so residents should only include information they intend to share.

This release does not send event emails, collect email subscriptions, or show nonfunctional notification toggles. Email announcements and reminders require a separate delivery service and opt-in preferences later. Recurring-event rules and RSVPs are also deferred.

## Verification

- Create an event as a regular approved resident; verify another resident sees it immediately.
- Sign in as another resident and confirm they can view but cannot edit or cancel it.
- Confirm an administrator can edit or cancel it; confirm an outsider or unapproved account cannot access it.
- Add a multi-day all-day event and verify the last day is included in the display and calendar export.
- Check a timed event in Chicago daylight and standard time, and from a device configured for another timezone.
- Open the same event in two sessions, save one, then try saving the older copy: it should request reloading rather than overwrite.
- Download an event and import it into a personal calendar. Check its date/time and note that updates are manual.

Automated local checks cover RLS, creator/admin permissions, membership revocation, stale revisions, event ranges, timezone transitions, all-day boundaries, safe text rendering, calendar exports and cleanup on sign-out. CDN URLs were checked. Live Supabase behavior and visual browser QA were not verified in the local checks.
