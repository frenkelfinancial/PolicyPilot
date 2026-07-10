# PROMPT 09 — Re-apply the lost mass-texting edits, verify nothing is truncated, commit + push

Paste everything below this line into Claude Code, run from the repo root.

---

## What happened (context you must understand first)

During the previous mass-texting session (spec: `PROMPT_07_mass_texting_CLAUDE_CODE.md`), a file-sync glitch truncated files on disk mid-write and corrupted the git index. The damage was repaired as follows:

- The power-dialer fix (commit `e9ff716`) was already pushed and is intact — do not touch it.
- The 9 tracked files that had UNCOMMITTED mass-texting edits were truncated mid-token (one literally ended in `verify_jwt = fal`; `package.json` was invalid JSON). They have been **reverted to HEAD**, so your previous edits to them are gone from the working tree.
- The truncated (incomplete but informative) versions of those 9 files were preserved in `.truncated-backup-20260709/` — use them as a reference for what you intended, but NEVER copy them verbatim: every one of them is missing its tail.
- All NEW untracked files from the texting work survived intact and are still in the tree: `_shared/broadcast-gate.ts` + test, `_shared/broadcast-pacing.ts` + test, `_shared/csv.ts` + test, `_shared/leads.ts` + test, `_shared/messaging-send-core.ts` + test, `_shared/messaging-shared.test.ts`, `data/sql/020_texting_broadcasts.sql`, and the function folders `a2p-assign-number/`, `messaging-broadcast-create/`, `messaging-broadcast-run/`, `messaging-recipients-import/`.

Your job: re-apply the lost edits to the 9 reverted files so the intact new modules are actually wired in, prove it with tests, then commit and push EVERYTHING to GitHub.

## The 9 reverted files and what each needs

Reconstruct intent from three sources in priority order: (1) the intact new modules and their tests — the `.test.ts` files are the executable spec for what the shared code must expose; (2) `PROMPT_07_mass_texting_CLAUDE_CODE.md`; (3) the partial versions in `.truncated-backup-20260709/`.

1. `supabase/functions/messaging-send-sms/index.ts` — refactor to call the shared send core in `_shared/messaging-send-core.ts` (messages row → `wallet_hold` → Telnyx send → void on failure / settle on delivery) instead of its own inline copy. Single-send behavior must be byte-identical in effect: same request/response shape, same compliance gate call, same billing. The backup copy shows how far this refactor got.
2. `supabase/functions/messaging-send-mms/index.ts` — same refactor as sms.
3. `supabase/functions/messaging-send-email/index.ts` — same pattern per PROMPT_07 §5 (email stays dormant; do not enable anything new — the backup shows the intended shape).
4. `supabase/functions/_shared/messaging-shared.ts` — the truncated backup is much SHORTER than HEAD, meaning code was being moved out of it (into `messaging-send-core.ts` / `broadcast-gate.ts`). Reconcile so that: `runComplianceGate` keeps its exact signature and semantics, nothing is defined twice across the shared modules, and the intact `messaging-shared.test.ts` passes against it.
5. `supabase/functions/_shared/telnyx-10dlc-adapter.ts` — the backup ends mid-`export async f`; it was growing a function (campaign number-assignment used by the intact `a2p-assign-number/` function — read that folder to see exactly what it imports, and implement precisely that export).
6. `package.json` — restore the new test scripts. The backup preserves the start: `test:email` and a `test:messaging` script enumerating the shared test files; it's cut off mid-list. Recreate `test:messaging` to include ALL intact test files: `segments.test.ts`, `tcpa.test.ts`, `phone.test.ts`, `messaging-shared.test.ts`, `messaging-send-core.test.ts`, `broadcast-gate.test.ts`, `broadcast-pacing.test.ts`, `csv.test.ts`, `leads.test.ts`. Result MUST be valid JSON (`node -e "require('./package.json')"`).
7. `supabase/config.toml` — HEAD already covers the existing webhook/cron functions. Add `verify_jwt = false` entries ONLY for whichever NEW functions are genuinely not called with a user JWT (per PROMPT_07: `messaging-broadcast-run` if it's invoked by pg_cron/self-invocation — check how the intact `messaging-broadcast-create/` kicks off the runner and match reality). Functions called by the authenticated browser client (`messaging-broadcast-create`, `messaging-recipients-import`, `a2p-assign-number`) must NOT be listed. Read the long comment at the top of config.toml before editing; keep its rationale intact.
8. `docs/PHASE2_S2_COWORK_CHECKLIST.md` — re-apply the checklist updates (backup shows a red/green gate table being added; finish it sensibly).
9. `docs/email-parsing-build-plan.md` — the backup is slightly LONGER than HEAD and ends mid-markdown-table; re-apply whatever status/table update was in progress if you can infer it, otherwise leave HEAD as-is and note that in the summary.

## Verification (all must pass before committing)

1. `node -e "require('./package.json')"` — valid JSON.
2. `npm run test:messaging` and `npm run test:email` — all green.
3. `deno check` every edge function file you touched plus `a2p-assign-number/index.ts`, `messaging-broadcast-create/index.ts`, `messaging-broadcast-run/index.ts`, `messaging-recipients-import/index.ts` (imports must resolve against the reconciled shared modules). Pre-existing esm.sh/SupabaseClient type-resolution errors are known noise; zero NEW errors.
4. Anti-truncation check — for EVERY file you create or modify, confirm the last line is syntactically complete (e.g. `tail -c 80` each one and eyeball it; a file ending mid-token means the sync glitch recurred — if you see that, stop, re-write the file, and re-verify).
5. `git diff` review: no unrelated files changed; single-send SMS/MMS request/response and billing behavior unchanged.

## Commit + push (mandatory)

1. Delete `.truncated-backup-20260709/` (it must never be committed) — or add it to `.gitignore` if deletion is blocked.
2. Stage everything texting-related: the 9 re-edited files, ALL the intact untracked new files listed above, `data/sql/020_texting_broadcasts.sql`, `PROMPT_07_mass_texting_CLAUDE_CODE.md`, and this prompt file (`PROMPT_09_restore_texting_edits_and_push_CLAUDE_CODE.md`).
3. Commit with a descriptive message (e.g. `Mass texting: broadcasts, shared send core, CSV import — re-applied after file-truncation incident`) and `git push` to `main`.
4. `git status` must be clean afterward (nothing modified, nothing untracked except intentionally ignored files). Paste the final `git status` and `git log --oneline -3` in your summary.

## Constraints (unchanged from PROMPT_07)

- Build in the working tree only: do NOT deploy edge functions, do NOT run the 020 migration, do NOT set secrets, do NOT submit A2P or send anything live. Stop at the SQL/deploy gate and report a diff summary.
- Money stays in mills; reuse the wallet + compliance rails, never fork their logic; every broadcast recipient goes through `runComplianceGate` with no bypass path.
- Do not modify the power-dialer files (`power-dialer.html`, `telnyx-dialer-skip`, `_shared/dialer-next-lead.ts`, `telnyx-call-status`) — they are freshly fixed and pushed.
