# PROMPT 6 — Claude Code — Finish Phase 2 deploy: Resend signing secrets (TWO endpoints) + cron scheduling. Test mode only, no live sends.

> Replace the three `<PASTE…>` placeholders with the copied secret values before running.

## CONTEXT (already done — do not redo)
- `019_messaging_compliance.sql` applied and verified.
- All 9 functions deployed and ACTIVE.
- `TELNYX_MESSAGING_PROFILE_ID` and `TELNYX_PUBLIC_KEY` already set.
- Two Resend webhooks were created in the dashboard (one per endpoint). **Resend issues a
  SEPARATE signing secret per endpoint**, so there are TWO `whsec_` values — the single
  `RESEND_WEBHOOK_SECRET` assumption must become two secrets. Details below.

## TASK 1 — Resend signing secrets (two, not one)
Webhook A (delivery), id `86308238-33bc-48db-b79f-5cc42d311483`:
- URL: `https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/messaging-delivery-webhook`
- Events: `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`

Webhook B (inbound), id `06060a7c-efcb-4175-a046-f3eef8a36905`:
- URL: `https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/messaging-email-inbound-webhook`
- Event: `email.received` — this is the exact inbound event name; update the adapter
  comment/parser in `messaging-email-inbound-webhook` you flagged as unverified. Confirmed `email.received`.

Set secrets:
```
RESEND_WEBHOOK_SECRET         = <PASTE_DELIVERY_WHSEC>   # used ONLY by messaging-delivery-webhook
RESEND_INBOUND_WEBHOOK_SECRET = <PASTE_INBOUND_WHSEC>    # NEW; used ONLY by messaging-email-inbound-webhook
```

Code change (required — do not share one secret across both, the Svix signatures won't match):
- `messaging-email-inbound-webhook` must verify its Resend/Svix signature against
  `RESEND_INBOUND_WEBHOOK_SECRET`, not `RESEND_WEBHOOK_SECRET`.
- `messaging-delivery-webhook` stays on `RESEND_WEBHOOK_SECRET`.
- If `webhook-verify.ts` is shared, pass the correct secret in from each function rather
  than reading a single hardcoded env inside the helper.
- Redeploy both `messaging-delivery-webhook` and `messaging-email-inbound-webhook` after
  setting the secrets.

Note (no action needed to test delivery): `email.received` only fires once the sending
domain's inbound MX points to Resend (pending §2.1 DNS work), so inbound reply threading
can't be end-to-end tested yet. Delivery/bounce verification works now.

## TASK 2 — Cron scheduling
Do NOT mint a new `WALLET_CRON_SECRET` and do NOT ask me for its value. **Recover the
existing one yourself**: the Phase 1 wallet-renewal cron job embeds the same bearer token
as plaintext in `cron.job.command`. Read it back with
`SELECT jobid, jobname, schedule, command FROM cron.job;`, extract the `Bearer <token>`
value the Phase 1 job uses, and REUSE that exact value. (Rotating it would break the Phase
1 renewal crons that still carry the old value, and it must equal the function's
`WALLET_CRON_SECRET` env, which is unchanged.)

Schedule both new jobs with `cron.schedule()`, sending `Authorization: Bearer <recovered
value>`:
- `messaging-timeout-sweep`
- `a2p-status-poll`

Use the cadence defined in the Phase 2 build plan. If unspecified there, propose one and
ask before finalizing (do not guess silently) — e.g. sweep every 15 min, `a2p-status-poll`
hourly.

Secret-storage: match whatever the Phase 1 jobs already do for consistency. If Phase 1
embeds the token as plaintext in `cron.job.command`, follow the same pattern here (don't
introduce a one-off Vault path just for these two). If you think Vault is worth adopting,
flag it for a separate hardening pass across all cron jobs rather than doing it piecemeal.

## TASK 3 — Verify, then stop (test mode, no live sends)
1. `supabase secrets list` shows `RESEND_WEBHOOK_SECRET`, `RESEND_INBOUND_WEBHOOK_SECRET`,
   `WALLET_CRON_SECRET`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_PUBLIC_KEY`.
2. Re-curl `messaging-delivery-webhook` and `messaging-email-inbound-webhook` with a bad/
   missing signature → expect YOUR function's signature rejection (401), not the gateway.
   If feasible, confirm each verifies against its OWN secret (a delivery-signed payload
   POSTed to the inbound URL should fail, and vice versa).
3. Confirm both cron jobs appear in `cron.job` with the intended schedule, and that
   invoking each function with the correct bearer returns 200.
4. Send NOTHING live. SMS/MMS stay blocked until A2P is approved.

Report back: secrets set (digests only), files changed for the inbound-secret split, the
`cron.job` rows + which secret-storage approach you used, and the verification results.
