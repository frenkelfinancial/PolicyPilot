# PolicyPilot — Underwriting Hub

Single-file HTML life-insurance dashboard for FFL agents. Quote estimator (FE / Term / IUL),
policy tracker, drafts calendar, bonus calculators (FFL VP, Americo UFirst, Am-Am Bonus
Bucks), and an underwriting cheat sheet — all in one HTML file with no build step.

## Folders

```
.
├── index.html      ← THE app. CSS + JS + HTML in one file. Open it in a browser.
├── data/           ← Extracted reference tables (JSON). Diff-friendly snapshots
│                     of rate sheets, comp tables, UW class lookups. NOT loaded at
│                     runtime — `index.html` is the runtime source of truth.
├── docs/           ← Architecture, upgrade roadmap, security notes, data sources.
├── src/            ← Scratch space for split modules. Empty by default. Use only
│                     when a section grows past ~200 lines or needs isolated work.
├── assets/         ← Logos, screenshots, official comp-guide PDFs, rate sheets.
└── archive/        ← Snapshots of `index.html` taken before large refactors.
```

## Working rule

**`index.html` is the source of truth.** Edit it directly. Subfolders are for
materials that *support* the file — never for code split out from it that has
to be re-merged. Two sources of truth drift apart fast and rate-sheet bugs are
expensive.

When a single section becomes too unwieldy to edit in one file (rare),
extract it to `src/<area>/` and add a tiny concat step. Until then, keep it
in `index.html`. See [docs/architecture.md](docs/architecture.md) for the
internal map of `index.html`.

## Before any non-trivial change

Read `docs/architecture.md` first to find the right line range to edit.
For carrier comp / rate / UW changes, also update the matching JSON in
`data/` so future-you can diff the change.

## Known issues

See [docs/security-notes.md](docs/security-notes.md) and
[docs/upgrade-roadmap.md](docs/upgrade-roadmap.md). The AI health parser
currently can't work in production as written — it calls Anthropic's API
from the browser with no key and an invalid model id.
