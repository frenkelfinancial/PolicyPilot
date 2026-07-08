# PolicyPilot / ProducerStack — notes for Claude Code

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
