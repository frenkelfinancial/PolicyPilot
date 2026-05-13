# src/

**Empty by default. Don't fill this folder unless `index.html` becomes too large
to edit comfortably.**

## When to extract

Extract a section to `src/<area>/` only when:
- The section exceeds ~400 lines AND
- You're about to do a multi-step refactor on it AND
- You expect at least one more refactor in the next month

If those don't all hold, edit `index.html` in place. Extraction creates a build
step (concat back to `index.html`) and a drift risk that costs more than the
ergonomic win for small sections.

## How to extract (when the time comes)

1. Make a snapshot: `cp index.html archive/index-$(date +%Y-%m-%d).html`
2. Cut the section into `src/<area>/<area>.html` (or `.css` / `.js`).
3. Replace it in `index.html` with a marker comment:
   `<!-- BUILD: src/<area>/<area>.html -->`
4. Add a `build.sh` at the repo root that:
   - reads `index.html`
   - replaces each `<!-- BUILD: path -->` with the contents of `path`
   - writes the result to `dist/index.html`
5. Treat `index.html` as the **template** and `dist/index.html` as the build
   output. Update the README to match.

Until step 4 is needed, this folder stays empty.

## Suggested split (only if/when it happens)

```
src/
├── styles/         ← tokens, layout, components, tables, utilities
├── partials/       ← sidebar, topbar, quoter, tracker, drafts, bonuses, uw, modal
├── scripts/        ← comp-engine, rate-engine, ai-health, uw-class,
│                     quote-fe, quote-term, quote-iul, policies,
│                     drafts-calendar, bonus-{ffl,americo,amam},
│                     uw-cheat-sheet, eapp-urls, nav, init
└── data/           ← (if loading via fetch) the JSON tables from /data
```
