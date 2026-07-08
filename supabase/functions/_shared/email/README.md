# `_shared/email` — carrier email pipeline (pure core)

Runtime-agnostic, dependency-free building blocks for the Gmail carrier-parsing
feature. Runs unchanged in **Deno** (edge functions) and **Node 24** (local
tests via native TS type-stripping). No LLM tokens are spent here — this is the
deterministic layer that keeps 95%+ of inbox volume away from Claude.

## Files
| File | What it is |
|---|---|
| `types.ts` | `SenderRow` (mirrors the `carrier_senders` table) + `Classification` result union. |
| `carrier-senders.ts` | Code-side **mirror** of `supabase/seed_carrier_senders.sql` (incl. `priority`) + `KNOWN_CARRIER_DOMAINS`. The DB table is the runtime source of truth; this exists for the pure classifier + tests. **Keep in sync with the seed.** |
| `classifier.ts` | `classifyMessage(from, subject, senders?)` → matched row \| `unclassified` (review) \| `null` (not a carrier email). Deterministic. |
| `cleaner.ts` | `htmlToText`, `stripQuotedReplies`, `stripDisclaimers`, and `trimForExtraction` — strip boilerplate before extraction. |
| `*.test.ts` | Unit tests (`node:test`). The classifier test is data-driven from `docs/carrier_sender_map.json`. |

## Run the tests
```bash
npm run test:email
```
Requires Node ≥ 23.6 (this repo is on Node 24) for `.ts` type-stripping. No
build step, no dependencies.

## Matching semantics (see also the seed file header)
1. Lowercase the From address; match `from_pattern` as SQL-LIKE (`%` = any run).
2. If several rows match the address, evaluate `subject_pattern` (case-insensitive
   regex) in **ascending `priority`**; first hit wins.
3. `subject_pattern = null` matches any subject (the sender's default row).
4. No row but a **known carrier domain** → `unclassified` → review queue.
5. No row, unknown domain → `null` → ignore silently.

## How downstream code should branch on a result
- `null` → not a carrier email; drop, don't log.
- `status: "unclassified"` → insert to review queue (`reason: 'unclassified'`).
- `status: "matched"`, then by `route`:
  - `ignore` → count and drop (never reaches Claude).
  - `nudge` (`content_type: "login_link"`) → insert `portal_nudges`; **never fetch
    the link, never call Claude.**
  - `policy_tracker` / `commission_summary` → `trimForExtraction(body)` then hand
    to the Haiku extractor (next steps).

## Adding real `.eml` fixtures (recommended before Phase 2)
Drop exported emails in `./fixtures/<carrier>/<something>.eml` and extend the
tests to assert real bodies clean up to just their data lines. Keep fixtures
**scrubbed** of anything you don't want in the repo, or store only the trimmed
excerpt — full raw carrier emails contain client PII (see build plan §7).
