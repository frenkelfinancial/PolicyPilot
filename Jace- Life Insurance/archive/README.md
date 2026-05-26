# archive/

Snapshots of `index.html` taken before large refactors so it's easy to roll
back or diff "what changed in the v3 redesign."

## Naming

`index-<YYYY-MM-DD>-<short-tag>.html` — e.g.
- `index-2026-05-07-initial-import.html` (the gist as imported)
- `index-2026-06-15-pre-supabase-sync.html`
- `index-2026-08-01-pre-dark-light-toggle.html`

## When to snapshot

- Before any change touching more than ~5% of the file
- Before extracting a section to `src/`
- Before a rate-table refresh (so old quotes can be reproduced)
- Before any production deploy
