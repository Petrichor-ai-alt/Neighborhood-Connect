# Working on Neighborhood Connect

## Start from the latest GitHub code

Before making any change, fetch the current `main` head from
`Petrichor-ai-alt/Neighborhood-Connect` and refresh the local checkout from that
commit. Read any repository instructions from that same commit. The user may
edit files directly in GitHub; never assume a previous local copy is current.
Preserve user changes. If using a connector rather than git, fetch the repository
tree and relevant text files pinned to the current head SHA.

Before publishing, check that the remote head has not changed. Use a guarded
branch update with the expected head SHA. If it changed, refresh and reconcile
against the newer code; do not force-push over user edits.

## Keep code readable

Use two-space indentation and the repository Prettier settings. Run `npm ci`,
`npm run format`, and `npm run format:check`. Format SQL with the configured SQL
plugin and keep procedural function bodies readable. Commit formatter settings
and lockfile changes when dependencies change. Website files remain static and
require no build or package installation to serve.

## Verify changes

For behavior or permission changes, run existing checks with `npm ci --prefix
tests` and `npm test`. Formatting must preserve application behavior, SQL
permissions, and existing user data. Do not claim live Supabase or Google API
verification when only local tests were run. Apply database upgrades only through
an authorized database connection; otherwise provide the migration for the user
in Supabase SQL Editor.

## Hosting and data

GitHub Pages serves `main` at the repository root. Keep rollback commits available.
Never put personal household records, database passwords, service-role keys, or
invitation tokens in repository files. Browser-restricted Maps and Supabase
publishable keys are browser-visible configuration.
