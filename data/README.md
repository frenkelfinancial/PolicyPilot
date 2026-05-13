# data/

Reference snapshots of the data tables embedded in `index.html`. **Not loaded at
runtime.** `index.html` is the runtime source of truth.

## What lives here

JSON exports of the carrier / rate / UW tables, kept in this folder so they're:
- Diff-able in PRs when rates change
- Reviewable without scrolling through a 2,000-line HTML file
- Ready for a future `fetch()`-based loader if/when the app is split

## Files (extract on demand)

When a table is about to change, extract it to JSON first, edit the JSON, then
mirror the change in `index.html`. Suggested filenames:

| File | Source in `index.html` |
|---|---|
| `compensation-table.json` | `COMP` (line 852) |
| `fe-rates.json` | `FE_RATES` (line 906) |
| `carrier-multipliers.json` | `CARRIER_MULTS` (line 931) |
| `uw-class-lookup.json` | `UW_CLASS` (line 1087) |
| `uw-cheat-sheet.json` | `UW_DATA` (line 1792) |
| `build-chart.json` | `BUILD_CHART` (line 1886) |
| `build-limits.json` | `BUILD_LIMITS` (line 1933) |
| `eapp-urls.json` | `EAPP_URLS` (line 1226) |
| `americo-milestones.json` | `AM_MS` (line 1687) |
| `conditions.json` | the AI system-prompt condition list (line 980) |

## Why not extract them all now?

Two sources of truth drift. Extract only when about to change a table — that
way every JSON file in this folder corresponds to a real edit, not stale data.

## Worked example

`compensation-table.json` is provided as a reference example so the pattern is
concrete. If you change carrier comp percentages, edit both `index.html` and
this JSON file in the same commit.
