# PROMPT 3 (Phase 2 of 3) — Claude Code — Usage Rails, Never-Charge-Undelivered & Compliance Moat (BUILD + GO-LIVE)

> Purpose: Add SMS, MMS, and email metering on top of the Phase-1 wallet, and
> build the two features that beat Ringy: **we never charge for an undelivered
> message**, and **A2P 10DLC registration + TCPA compliance are handled for the
> user**. You write the code AND take it live (SQL, Telnyx API, deploy) — but
> stop for my approval before live/destructive steps. The browser/human-only
> bits (DNS for email, Telnyx A2P brand approval, inbox deliverability check)
> are done in the Cowork prompt (file 05, §2) — hand those off clearly.
>
> Run only after Phase 1 (files 01–02) is verified LIVE. Start by re-reading
> what Phase 1 actually shipped — build on the real schema, not assumptions.

---

## North-Star principles — three of the four get built here
1. **Billing transparency** — every SMS/MMS/email debit is an itemized ledger row (segments counted, rate shown).
2. **Never charge for undelivered messages** — THE headline feature: money is *held* at send, *settled* only on a carrier "delivered" event, *voided* (net $0) on failure/undelivered. Opposite of Ringy, which charges for blocked texts.
3. **Deliverability & compliance as a done-for-you moat** — A2P 10DLC brand+campaign handled for the user; TCPA gates (consent, quiet hours, DNC, opt-out keywords) auto-enforced.
4. **Email that actually works** — sends from the user's verified domain, logs replies back, real signature, lands in inbox.

## Hard rule: APPROVAL GATES + TEST FIRST
Do everything in test/sandbox first (Telnyx test creds, no live sends). Before running SQL on prod, before any live Telnyx/messaging config, and before enabling real outbound messaging — print what you'll do and wait for my "go." Never live-send during setup.

## Step 0 — Re-read Phase 1's shipped reality (mandatory)
Confirm the ACTUAL names of the wallet tables, the `wallet_hold/settle/void` RPC signatures, the `billing_config` mills columns (`sms_segment_mills=10`, `mms_mills=30`, `email_mills=1`), and the ledger `status` enum (`pending`/`settled`/`voided`). Everything below MUST use those real names.

## Ground truth (verify against repo)
- Money in **mills**; all movement goes through the Phase-1 wallet RPCs — never write balances directly.
- **No SMS/MMS sending exists yet** — net-new. Telnyx is the provider (mirror the auth/secret pattern of existing `telnyx-*` functions).
- Email today is Resend (digests only); per-agent outbound email is net-new.

## Build + wire, in this order

### 1. Schema — `data/sql/014_messaging_compliance.sql` (+ dated mirror), idempotent, then apply it (SQL gate)
- **`public.messages`** — one row per outbound SMS/MMS/email: `id`, `agent_id`, `channel ('sms'|'mms'|'email')`, `to_address`, `from_number/from_email`, `body_preview`, `segments int`, `provider_message_id`, `status ('queued'|'sent'|'delivered'|'failed'|'undelivered')`, `hold_ledger_id uuid`, `consent_id uuid`, `created_at`, `delivered_at`, `failed_reason`. Index `(provider_message_id)`, `(agent_id, created_at desc)`.
- **`public.consent_records`** — TCPA proof: `agent_id`, `contact_phone/email`, `consent_type ('express_written'|'express'|'none')`, `source`, `captured_at`, `revoked_at`.
- **`public.dnc_list`** — per-agent + global do-not-contact; opt-out keywords auto-add on inbound.
- **`public.a2p_registrations`** — `agent_id`, `brand_id`, `campaign_id`, `status ('pending'|'approved'|'rejected')`, `brand_fee_mills`, `campaign_fee_mills`, `monthly_fee_mills`, `registered_at`.
- Add `billing_config` A2P fee columns if absent. RLS: agents read only their own rows; service role writes.

### 2. Segment counting helper (`_shared/segments.ts`) — bill this exactly
GSM-7 vs UCS-2 detection; 160/153 (GSM-7 single/concat) and 70/67 (UCS-2) boundaries; `segments = ceil(len/boundary)`; emoji/unicode forces UCS-2. **Unit-test it.** `amount_mills = segments * sms_segment_mills`.

### 3. Send functions with AUTHORIZE-THEN-CAPTURE (never charge undelivered)
Create `messaging-send-sms/`, `messaging-send-mms/`, `messaging-send-email/`. Each MUST, in order:
1. **Compliance gate before any money/send:** valid consent exists; recipient not on `dnc_list`; within TCPA **quiet hours** for recipient tz (default 8am–9pm local); agent has an **approved A2P campaign** (SMS/MMS). Any fail → reject with a clear reason, **charge nothing.**
2. **Compute cost** and **`wallet_hold`** it (pending ledger row). Balance can't cover → `402 insufficient_balance`, no send.
3. **Send via Telnyx / email provider**; store `provider_message_id` + `hold_ledger_id` on the `messages` row.
4. **Do NOT settle** — the hold stays pending until the delivery webhook resolves it.

### 4. Delivery webhook — `messaging-delivery-webhook/` (verify signature)
- `delivered` → `wallet_settle(hold_ledger_id)`, `messages.status='delivered'`.
- `failed`/`undelivered` → `wallet_void(hold_ledger_id)` → **net charge $0**, set status + `failed_reason`. **This is the promise.**
- **Timeout sweep** cron: void holds older than N hours with no final receipt. Idempotent on `provider_message_id` — retries never double-settle/void.

### 5. Inbound + opt-out — `messaging-inbound-webhook/`
Log inbound; on STOP/UNSUBSCRIBE/CANCEL/END/QUIT auto-add sender to `dnc_list` and send the one required confirmation. Inbound is free.

### 6. A2P 10DLC registration — `a2p-register/`
Drive Telnyx's brand + campaign registration on the agent's behalf (collect business info → submit brand → submit campaign → poll status into `a2p_registrations`). When Telnyx bills brand/campaign/monthly fees, **debit the wallet** as pass-through `a2p_registration` line items with the true amount in the ledger description. **Block SMS/MMS until the campaign is `approved`**, with clear in-app status. Verify real Telnyx 10DLC API params; if any are uncertain, put them behind a clearly-marked adapter and flag them for the Cowork/browser step (file 05, §2).

### 7. Email that actually works
`messaging-send-email` sends from the agent's **verified domain** (config/secret-driven, never hardcode the from-address), includes the signature, sets threading headers so replies log back to the conversation, and debits **1 mill ($0.001)** through the same hold→settle-on-delivery path.

### 8. Deploy + wire (gates apply)
`supabase secrets set` (Telnyx messaging key, webhook signing secrets, email key/from). `supabase functions deploy` all the new functions. Schedule the timeout sweep + A2P status-poll via `pg_cron`. Set Telnyx DLR + inbound webhook URLs to the deployed functions **that you can do via the Telnyx API**; anything that requires the Telnyx dashboard, hand to file 05.

### 9. Verify (paste results)
- No-consent / DNC / quiet-hours / no-approved-A2P sends → all blocked at **$0**.
- Inbound "STOP" → auto-DNC + one confirmation, further sends blocked.
- **Delivered SMS** → hold settles, −(segments×$0.01). **Failed SMS** → hold voids, **$0**. **No-DLR** → timeout voids, $0.
- 10-emoji message bills as UCS-2 (67-char) segments. **MMS** −$0.03 on delivery; **email** −$0.001 on delivery; $0 if they fail.
- Webhook retries never double-settle/void.

## Hand off to Cowork (file 05, §2) — the browser/human-only steps
List these clearly for me at the end: verify the email sending domain (SPF/DKIM/DMARC/return-path DNS at my registrar), complete/approve the **Telnyx A2P brand+campaign** if it needs the dashboard, and confirm a test email lands in **Primary/Inbox** (a real inbox check you can't do). Mark which block live SMS/email go-live.

## Do NOT
- Don't bypass the wallet RPCs. Don't charge on send — only hold, then settle on delivery; undelivered = $0 always.
- Don't send SMS/MMS without approved A2P + consent + quiet-hours/DNC checks.
- No Phase-3 rich UI (compliance *status* indicators needed to block sending are fine).
- Never hardcode provider keys, from-addresses, or fees. Nothing live/destructive without my go.
