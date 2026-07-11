# PolicyPilot / ProducerStack — notes for Claude Code

## Carrier bonus tracker
- **Source of truth for bonus programs:** `data/carrier_bonuses.json` — carrier-official agent bonus/incentive programs (45 carriers, researched 07/2026). CARRIER-ONLY by design: never add IMO/agency-level bonuses (e.g. FFL VP bonus) to this file.
- **Mirror rule:** the `CARRIER_BONUSES` const in `app.html` mirrors this JSON (same pattern as `COMP` ↔ `data/compensation-table.json`). Any change to one must be applied to both.
- **Never invent tier numbers.** Entries with `bonus_type: portal_only` or empty `tiers` get no numeric projections in the UI. All displayed payouts are estimates ("est." prefix) subject to carrier persistency/quality metrics.
- Payout shapes differ per carrier — don't generalize: Am-Am Bonus Bucks = highest band only, not cumulative; MoO 4 Quarters Club = cliff (10% of TOTAL quarter ANBP once ≥$25k); Corebridge = cumulative policy-count ladder, SimpliNow Legacy SIWL only (GIWL excluded), tiers change every quarter; Americo UFirst = fixed window (last one ended 2026-05-29).
- **Data decays on a schedule:** Corebridge tiers flip quarterly (~Oct 1 next), Americo announces new UFirst windows after each one ends, MoO/Aetna publish new flyers each cycle. When refreshing, update `as_of` and per-entry `status`/`source_date`, and regenerate `data/carrier_bonuses_*.xlsx` if present.
- Build spec: `docs/bonus-tracker-build-prompt.md` (payout math, period engine, carrier-ID mapping, fixture tests).

## Carrier email parsing feature
- **Source of truth for email classification:** `docs/carrier_sender_map.json` — maps every carrier sender address to email type, content type (body / pdf / login_link), and routing destination (policy_tracker / commission_summary / nudge / ignore). Built from real inbox samples; do not invent sender addresses or types not listed there.
- **Build plan:** `docs/email-parsing-build-plan.md` — architecture, phased tasks, schema, matching rules, risks. Follow the phase order.
- **DB seed:** `supabase/seed_carrier_senders.sql` — inserts for the `carrier_senders` table (requires a `priority int default 10` column; see file header for matching semantics).

Key gotchas encoded in the map (read its `key_findings`):
- Transamerica masks policy numbers (`xxxxx76911`) — match on last 5 digits.
- `noreply@aatx.com` sends two different email types — split on subject regex, match addresses case-insensitively.
- Ethos mixes marketing and transactional on one sender — subject allowlist, ignore by default.
- Mutual of Omaha underwriting mail comes from personal underwriter addresses — match domain + subject pattern.
- Never fetch links from login-link emails (Corebridge secure messages, Americo portal notifications) — they become dashboard nudges only.
