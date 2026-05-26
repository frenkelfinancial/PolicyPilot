# Upgrade Roadmap

Prioritized list of upgrades. Tackle critical items first.

## CRITICAL

- [ ] **Fix the AI health parser.** Currently broken (no API key, invalid model id).
      See `security-notes.md`. Pick Option A (server proxy) or Option B (BYO key).
- [ ] **Backup / export of policies.** Tracker data is localStorage-only. One
      cleared cache = lost pipeline. At minimum, add an "Export JSON" button
      next to "+ Add Policy" that dumps `ff_policies` to a downloadable file.

## HIGH

- [ ] **Verify rate tables against current carrier sheets.** `FE_RATES` (line
      912) is described as "industry standard approximation" — quotes shown to
      clients should be exact. Either replace with carrier-published rates or
      label every quote prominently as "estimate; verify in carrier portal."
- [ ] **Verify `COMP` table against the FFL comp guide PDF.** Drop the comp
      guide PDF in `assets/` so the source is visible in the repo.
- [ ] **Persistency / placement penalty inputs.** Bonus calculators assume
      qualifying persistency — add a flag for "below threshold" so an agent
      doesn't see an inflated estimate.

## MEDIUM

- [x] **Book Intelligence Phase 1 — Term Conversion Radar.** *Landed 2026-05-10.*
      New `#sec-book-intel` tab between Leads and Calendar. Scores every term
      policy on entry, ranks by `urgency × est. commission × insurability risk`,
      surfaces opportunity cards with deterministic outreach drafts. Reads
      existing tracked policies plus a CSV backfill flow. Carrier conversion
      rules in `shared/data.js::CARRIER_CONVERSION_RULES` (10 carriers seeded).
      Plan: `/Users/tanner/.claude/plans/book-intelligence-implementation-cuddly-bentley.md`.
      Phase 2 (UL/IUL underperformance detector) is gated on a server proxy
      for Anthropic API calls — see CRITICAL item above re: AI parser.
- [x] **Supabase sync** for policies, leads, and contract level (multi-device, never lost). *Landed 2026-05-08.*
      Tables: `public.agents`, `public.policies`, `public.leads` — all RLS-locked
      to `auth.uid()`. Hybrid CRUD per `Patterns/Supabase Hybrid CRUD`:
      localStorage stays as the optimistic cache, Supabase is source of truth.
      Migrations live in `data/sql/001_agents_profile.sql` and
      `data/sql/002_policies_leads.sql`.
- [ ] **Activity log** — drop a row to a Supabase table on every policy
      add/edit/delete. See `Patterns/Activity Logging`.
- [ ] **Light/dark mode** — current is dark-only. See `Patterns/Dark Mode Token Swap`.
- [ ] **Master-detail policy view** — clicking a tracker row opens a full detail
      pane (notes, dates, commission breakdown, attachments). See
      `Patterns/Master-Detail Navigation`.
- [ ] **Confirm modal for delete** — currently no confirmation before deleting
      a policy. See `Patterns/Confirm Modal`.
- [ ] **Toast notifications** for save / delete / error. See `Snippets/Toast Notification`.

## LOW

- [ ] **PDF export** of a policy or a monthly drafts summary. See
      `Patterns/Data Export - PDF and Excel`.
- [ ] **Calendar week view** in addition to month view.
- [ ] **Filter / sort** controls on the policy tracker (by carrier, status, draft date).
- [ ] **More carriers** — North American, F&G, Anico, Columbus, National (currently
      only listed in the bonusable-percentages table, not the quoter).
- [ ] **More products** — Annuity quoter (currently only listed in bonusable %).

## Maintenance

- [ ] Convert rate / comp / UW data to standalone JSON in `data/` and load via
      `fetch()` at boot. Pros: one source of truth, easier diffs on rate
      changes, reviewable in PRs. Cons: needs a local server (file:// blocks
      fetch) or inlining at build. Defer until the file becomes painful.
- [ ] When `index.html` exceeds ~3,500 lines or any single section exceeds ~400
      lines, extract that section to `src/<section>/` and add a `build.sh` that
      re-concatenates. Until then, single file is the right call.
