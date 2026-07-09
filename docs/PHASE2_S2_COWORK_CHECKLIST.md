# Phase 2 — PROMPT_05 §2 go-live checklist (Cowork)

Tracking the four §2 blockers. **All must be green before live texting/email.**
Nothing here runs until Claude Code deploys Phase 2 in test mode. Sends that cost
real balance/fees are flagged 💲 — Cowork asks Jace before firing each.

- **App:** producerstackcrm.com/app.html — **Browser 2** (Windows, local)
- **Account:** jacef8778099@gmail.com ✅ confirmed logged in (2026-07-09)
- **Money:** mills ($1 = 1000). A2P fees recorded here must match Code's
  `a2p_registrations` pass-through ledger amounts.

Status key: ⬜ not started · 🟡 in progress · 🟢 green · 🔴 blocked

---

## Pre-req — Code deploy (owner: Jace → Claude Code)
- ⬜ `019_messaging_compliance.sql` applied (paste-and-run in Supabase SQL Editor)
- Secrets set:
  - 🟢 `TELNYX_MESSAGING_PROFILE_ID` = `40019edb-acf4-47da-ae79-9a712deda81a` (fetched from Telnyx portal, 2026-07-09 — only profile on account)
  - 🟢 `TELNYX_PUBLIC_KEY` = `S5U805VnXsA2jF5Ylywaab83GTsoAoltP2NJ/8To3GY=` (Telnyx API v2 webhook validation key)
  - 🟡 `RESEND_WEBHOOK_SECRET` — **TWO Resend webhooks created on Browser 2 (2026-07-09), each Enabled with its OWN `whsec_` signing secret** (Resend issues one per endpoint):
    - Delivery — `.../messaging-delivery-webhook` — events `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed` — webhook id `86308238-33bc-48db-b79f-5cc42d311483` → its `whsec_` = `RESEND_WEBHOOK_SECRET`
    - Inbound — `.../messaging-email-inbound-webhook` — event `email.received` (confirmed name; resolves Code's adapter flag) — webhook id `06060a7c-efcb-4175-a046-f3eef8a36905` → its `whsec_` needs a **second env** (e.g. `RESEND_INBOUND_WEBHOOK_SECRET`) or webhook-verify must accept either — **Code change required** (Code assumed one secret)
    - ⚠️ Jace to copy both `whsec_` values from each webhook's detail page and hand to Code (Cowork did not echo the secrets)
    - ⚠️ Inbound replies also need the domain's **inbound MX → Resend** configured (ties into §2.1) before `email.received` fires
  - 🟢 `WALLET_CRON_SECRET` — reused from Phase 1
- 🟢 9 functions deployed & verified · 2 crons scheduled (`messaging-timeout-sweep` */15, `a2p-status-poll` hourly) · **test mode, no live sends** (2026-07-09)
  - 🟢 Two-secret split verified: each webhook rejects the other's Svix signature (401), accepts its own (200)
  - 🟡 Known hardening item (non-blocking): all 4 cron jobs store the bearer token as plaintext in `cron.job.command` — Code recommends a single Vault pass later

---

## §2.1 — Email sending domain DNS  (owner: Cowork drafts records · Jace adds at registrar)  ⬜
Add the SPF, DKIM, DMARC, and return-path/MX records the email provider (Resend)
gives; use a `reports.`-style subdomain to isolate reputation. Wait for the
provider to show the domain **verified/green**.

Domain **producerstackcrm.com** already added in Resend (registrar **Porkbun**), created ~22 days ago, **outbound = Verified / "ready to send"** (checked 2026-07-09).

| Record | Type | Host | Value | Status |
|---|---|---|---|---|
| DKIM | TXT | `resend._domainkey` | `p=MIGfMA0…` | 🟢 verified |
| Return-path | MX | `send` | `feedback-smtp.us-east-1.amazonses.com` (prio 10) | 🟢 verified |
| SPF | TXT | `send` | `v=spf1 include:amazonses.com ~all` | 🟢 verified |
| Inbound | MX | `@` | `inbound-smtp.us-east-1.amazonaws.com` (prio 9) | 🔴 **not started** |
| DMARC | TXT | `_dmarc` | *(none created)* | 🔴 **missing** |

- Outbound sending (DKIM/SPF/return-path): 🟢 done → §2.3 deliverability can be tested now.
- **Inbound MX (`@`)**: 🔴 add at Porkbun to enable `email.received` / reply threading. ⚠️ Root `@` MX captures **all** inbound mail for producerstackcrm.com — confirm the domain has no other mailboxes, or use a subdomain instead.
- **DMARC**: 🔴 not present; recommend adding `_dmarc` TXT (starter: `v=DMARC1; p=none; rua=mailto:<you>`).
- **Status: 🟡 (outbound green; inbound MX + DMARC pending Jace at registrar)**

## §2.2 — Telnyx A2P 10DLC  (owner: Cowork drives dashboard · Jace pays fees 💲)  ⬜
Submit/finish the brand + campaign; **watch through to `approved`.** Record IDs and
the **real fees Telnyx charged** so Code's pass-through ledger matches. SMS/MMS stay
blocked until approved. ⚠️ Approval can take days.

State (2026-07-09): **no brand registered yet** — Telnyx 10DLC shows empty "Get started" state; `a2p_registrations` empty; gate fails closed (correct).

Brand form requires (business info Jace must supply): DBA/brand name · legal company name · legal form (LLC/sole-prop/corp) · vertical (industry) · **EIN** · website · business address · brand email · brand contact number.

- Telnyx-displayed brand fee: **$4.50** ⚠️ — Code's `billing_config.a2p_brand_fee_mills` default is 4000 ($4.00). Real pass-through should use $4.50; flag to Code. Campaign + monthly fees to confirm at campaign step (defaults $15 / $10).
- **Submission path decision:** register via **Code's `a2p-register` function** (writes `a2p_registrations` + fires the pass-through ledger + `a2p-status-poll` tracks it), NOT the Telnyx dashboard directly (dashboard-only leaves the app's gate/ledger empty). Coordinate the actual submit with Code once business info + fee approval are in.
- There is a **"mock brand"** option to test the 10DLC wiring without a real submission/fee.
- Brand ID: _(fill)_ · Brand status: ⬜
- Campaign ID: _(fill)_ · Campaign status: ⬜
- Real fees charged (record exact $): brand `$___` · campaign `$___` · monthly `$___`
- Ledger match check (vs `a2p_registrations` fee_mills): ⬜
- Adapter TODO fed back to Code (Telnyx `suspended`/`expired` field names): ⬜
- **Status: 🔴 not started** *(needs business info + fee approval; blocks all SMS/MMS)*

## §2.3 — Real inbox deliverability  (owner: Cowork 💲 small send)  ⬜
Send one test email to a real Gmail/Apple address; confirm **Primary/Inbox** (not
spam), DKIM passing, signature intact, and a reply threads back into the app.

- Test recipient: _(fill)_
- Landed in Primary/Inbox (not spam): ⬜
- DKIM = pass (view original / show-headers): ⬜
- Signature intact: ⬜
- Reply threaded back into app (plus-address match works): ⬜
- Resend inbound-parser TODO fed back to Code (payload shape): ⬜
- **Status: ⬜**

## §2.4 — Undelivered = not charged, visual proof  (owner: Cowork 💲 one send)  ⬜
Trigger one undelivered test text; confirm the app ledger shows **"Not charged ·
$0.00"** — the hold was placed then voided. This is the differentiator; verify on
screen.

- Undelivered text triggered: ⬜
- Ledger row reads "Not charged · $0.00" (hold → void, nothing settled): ⬜
- Balance unchanged before/after: ⬜
- Screenshot captured: ⬜
- **Status: ⬜**

---

## Sign-off
- All four green → Phase 2 clear for live texting/email.
- Any red → blocks go-live; note the blocker and hand back to Claude Code.

_Last updated: 2026-07-09 · Cowork_
