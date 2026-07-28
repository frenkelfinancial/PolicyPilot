# Texting UI — A2P registration, status wizard, and the SMS composer

**Built 2026-07-28.** PROMPT_15 Phase 4 + 5, plus the messaging composer.

The A2P backend has been complete and hardened since 2026-07-28 — a resumable
step machine, write-once brand/campaign ids at the database level, Sole
Proprietor registration, per-agent compliance pages, and a send gate keyed on
`phone_numbers.sms_capable`. None of it had a way in. An agent could not start
registration, enter their PIN, see where it stood, or send a message.

This is that way in. Three surfaces, all in `app.html`:

| Surface | Where | Function prefix |
|---|---|---|
| Registration explainer + EIN branch | `#a2pRegModal` | `a2pOpenRegModal` … |
| Status wizard | Settings → **Texting** (`#stg-texting`) | `a2pRenderTextingTab` … |
| Per-lead SMS thread | `#smsThreadModal`, opened by the **Text** button on a lead row | `smsOpenThread` … |

---

## 🔴 The production switch

```js
const A2P_ALLOW_PRODUCTION = false;   // app.html, top of the A2P block
```

`a2p-register` refuses to create a real brand unless the request carries
`allow_production: true` (see `_shared/a2p-registration.ts` → `resolveTelnyxEnv`,
and `docs/telnyx-10dlc-brands.md`). The UI ships with that flag **off**, so
every registration started from the app today attaches to the shared mock
sandbox brand: free, nothing debited, no Telnyx object created for the agent.

**Two things are not exercisable while it is off**, both by design of the
sandbox rather than of this UI:

1. **A mock brand can never be APPROVED.** Its placeholder EIN fails TCR
   vetting, so the wizard cannot get past "Carrier approved", and therefore
   neither number assignment nor an actual send can be reached.
2. **The sole-proprietor OTP step is skipped entirely in sandbox** —
   `advanceRegistration` short-circuits `if (isSoleProp && !isSandbox …)`. So
   the PIN screen never appears on a sandbox run.

Both the modal's result screen and the wizard render a **"Test registration"**
banner whenever `a2p_registrations.telnyx_env = 'sandbox'`, so nobody can
mistake a sandbox run for a real one.

Flipping it to `true` makes every registration real: **$4 at brand acceptance
and $14.50 when the campaign submits, then $1.50/month, per agent,
non-refundable, no undo.** It is
a constant rather than a setting deliberately — that is a spend decision and it
should appear in a diff.

---

## Task 1 — Registration

`Settings → Texting → Start registration` opens a modal that does three things
in order:

1. **Explains, before anything is submitted.** What 10DLC is, that we handle
   the submission, honest timings (24–48h business check, 3–7 business days
   campaign approval), and what it costs.
2. **Branches on the EIN question.** "Do you have an EIN for your business?"
   with both answers presented as equally valid, because most producers are
   1099 individuals with no EIN and the Sole Proprietor path exists precisely
   for them.
3. **Collects only what is missing.** Everything already in Settings →
   Business Profile is read back on screen rather than re-asked; the modal only
   adds legal name + EIN + entity type (standard) or legal first/last name +
   mobile (sole prop).

If the business profile is incomplete the branch buttons are disabled and the
modal names the exact missing fields with links to them — the same fields
`a2p-register` would reject on with `compliance_page_missing`, surfaced before
the agent types anything.

**Landing:** a submitted registration closes the modal and returns the agent to
the dashboard with a toast. A sole-prop registration that is `awaiting_otp`
stays on the Texting screen and puts the cursor in the PIN box, because that is
genuinely the next thing they have to do.

**Nothing here blocks the app.** Quoting, the policy tracker, the dialer and
everything else keep working while a registration pends. Only sending a text is
gated.

---

## Task 2 — Status wizard

Eight stages, each with a `pending` / `in progress` / `complete` / `failed`
chip:

```
Brand type → Business info → Compliance page → Brand submitted
  → [Mobile PIN verified — sole prop only] → Campaign submitted
  → Carrier approved → Number assigned
```

Every chip is derived from the row, never from a local guess — the same rule
the step machine follows server-side. "Did the brand get created?" is answered
by `brand_id` being non-null, not by a status string.

- **Failed stages** render the real reason. Brand/campaign failures come from
  `a2p_registrations.last_error` (written as `"<step>: <detail>"`, cleared when
  that step later succeeds); carrier rejections come from `rejection_reason`;
  assignment failures from `assignment_failure_reason`. Each gets a **Retry**.
  Retry on a registration step re-invokes `a2p-register`, which resumes from
  the furthest completed step rather than restarting — and cannot create a
  second billable brand even if it wanted to (`a2p_registrations_guard_ids`).
- **Honest timings inline**: 24–48h brand verification, 3–7 business days
  campaign approval, and 24–72h carrier propagation after assignment, with the
  explicit note that a failed test send at hour two is expected, not broken.
- **OTP entry** is inline with a live countdown against the 24-hour window and
  a resend that resets the clock. The block also states plainly that the $4 has
  been charged and the $14.50 has not — an agent who abandons before entering
  their PIN pays $4, never $18.50.
- **Refresh status** force-polls this agent only (see below).
- **Texting number card** shows which number carries the campaign, offers a
  picker when an approved agent owns several and none is attached, and for sole
  proprietors explains in plain language why they only get one.
- **Compliance page URLs** with copy + open buttons, mirrored from the Account
  tab because this is the screen where a reviewer's questions come up.

### Retry on a rejected registration

`a2p-register` deliberately answers `resubmission_requires_new_campaign` (409)
for a rejected registration that already has a campaign — a new campaign is
another $14.50 and a spend decision, not a retry. The wizard surfaces that
sentence rather than silently doing nothing.

---

## Task 3 — SMS composer

A **thread**, not a send box. `messaging-inbound-webhook` has been logging
replies into `inbound_messages` with nowhere to display them; a consumer who
answers a text and is met with silence is worse than one never texted.

- Outbound lives in `messages`, inbound in `inbound_messages`. A thread is the
  union of both, matched on the contact's E.164 and sorted by time.
- Per-message delivery status: `Sending… / Sent / Delivered / Failed / Not
  delivered`, plus `failed_reason` when there is one. After a send the thread
  re-reads at 5s and 15s so "Sending…" becomes "Delivered" on its own.
- Segment counter mirrors `_shared/segments.ts` exactly (GSM-7 160/153, UCS-2
  70/67) so the count on screen is the count the wallet bills.
- **"Sending from"** applies the same preference order as
  `resolveTextingNumber()` — configured caller ID when it is itself
  `sms_capable`, then primary, then the only one. Diverging would name a number
  the text does not actually go out on.

### Every gate is explained, never raw

The checks mirror the **order** of `runComplianceGate()` so the composer can
never look ready for a send the server would refuse:

| Server reason | What the agent sees |
|---|---|
| `a2p_not_approved` | Why texting is not on yet, per registration status, + link to the wizard |
| `no_sms_capable_number` | That owning a number is not the same as it being textable, + the 24–72h propagation note |
| `on_dnc_list` | That they replied STOP and only they can undo it |
| `no_consent` | The consent capture prompt (below) |
| `daily_limit_reached` | The server's own sentence + a link to the wizard |
| `quiet_hours` | The server's own sentence |

**Quiet hours are deliberately not pre-computed in the browser.** The timezone
inference lives in `_shared/tcpa.ts`; duplicating it client-side would drift.
A send outside the window is refused for free and its sentence is rendered.

---

## The consent gap this closed

`_shared/messaging-shared.ts` refuses any SMS without a current, unrevoked
`consent_records` row for the recipient. Until the texting UI shipped, the
**only** thing that ever wrote that table was `messaging-recipients-import` —
the broadcast CSV path. `lead-ingest` does not write it, and `consent_records`
has SELECT-only RLS (019 §8, re-verified against production 2026-07-28), so
the browser cannot either.

Net effect: a fully approved agent with an assigned texting number would have
had **every 1:1 text to a lead rejected with `no_consent`**.

`messaging-consent-record` closed the mechanical gap — an agent could attest
to consent and the row got written. **That is no longer the primary path.**

---

## 🔴 The campaign rejection, and what replaced the attestation

**The 10DLC campaign was rejected.** Carrier review would not accept the lead
vendor's "…and its licensed agents" language as opt-in evidence for a campaign
sending as Frenkel Financial Agency. The vendor will not change their form.

An agent attestation quoting that same vendor form inherits exactly the
weakness that got us rejected — it is our word about their wording. So consent
is now collected on **the agent's own hosted opt-in page**,
`/a/<slug>/sms-opt-in`, generated by the same database trigger as their
privacy policy and terms. Full detail in `docs/compliance-pages.md`; what
matters for this UI:

### 1. A lead row now tells the truth about texting

`leadTextingState(lead)` in `app.html` answers "can I text THIS person?" from
a stored `consent_records` row — which is what `runComplianceGate()` actually
reads — and the row renders accordingly:

| State | Text button | Extra action |
|---|---|---|
| `ready` | green, as before | — |
| `needs_optin` | muted | **Opt-in link** button, when the lead has an email |
| `opted_out` | red, "they replied STOP" | — |
| `no_phone` / `unknown` | muted | — |

> **`phone_numbers.sms_capable` answers a DIFFERENT question** — whether the
> AGENT's number may carry A2P traffic. It says nothing about the recipient.
> Green on a lead row means a consent record exists for that contact, and
> nothing else earns green: an agent who learns mid-compose that a green
> button was wrong stops trusting the colour.

State loads in **one pair of queries for the whole book** (`smsLoadLeadConsent`),
awaited in `bootDashboard` before the first render — a flash of green that
corrects itself says "you can text them", which is the one thing the button
must never say when it is not true. On failure it stays `unknown`, not
`ready`.

### 2. "Opt-in link" emails the page

`messaging-send-optin-invite` sends the lead their agent's opt-in URL by
email, from the platform sender with the agency's details in the body and
their business email as Reply-To.

**Email, and only email.** We may email these leads under the consent already
captured on the vendor's form; we may not text them under it — that is the
finding. It is a separate function from `messaging-send-email` because that
one runs `runComplianceGate()`, which requires a consent row, and the entire
purpose of this email is to reach someone who has none. Relaxing that gate to
fit would punch a hole in the only thing standing between us and an
unconsented send.

It refuses on a DNC hit for **either** the email or the phone: emailing an
invitation to opt back in, to someone who texted STOP, is the same
solicitation the STOP refused wearing a different channel.

### 3. The composer's `no_consent` prompt leads with the page

The prompt now offers "Email the opt-in link" first, with the URL and a copy
button. The attestation form is still there, second, inside a `<details>` and
behind a sentence explaining that a vendor form naming partners generally is
what carrier review already rejected. `messaging-consent-record` labels its
rows `consent_method = 'agent_attested'` so the two grades are distinguishable
forever after.

### What `messaging-consent-record` still does

- Auth'd, platform default `verify_jwt = true`, agent scoped from the JWT.
- `consent_type` is **never defaulted** — the caller must state it, matching
  the "never auto-write express_written" guardrail in
  `messaging-recipients-import`. The UI only offers written consent behind an
  attestation checkbox, because
  `billing_config.sms_require_written_consent` defaults to true and a verbal
  record would be accepted here and then rejected at send time.
- **Refuses when the contact is on the DNC list.** A person who texted STOP has
  revoked consent at the carrier level; recording new consent over that is the
  move TCPA enforcement exists to punish. They have to text START back, which
  `messaging-inbound-webhook` already handles.
- Provenance is stored verbatim in `consent_records.source` as
  `agent_attested: <where>`, and now also in `consent_method`.

---

## Backend changes made for this UI

### `a2p-status-poll` — two callers, two auth modes

It stays `verify_jwt = false` (pg_cron has no Supabase JWT) and now
distinguishes its callers itself:

- **Bearer `WALLET_CRON_SECRET`** → the full sweep, unchanged.
- **anything else** → verified as a user JWT with `auth.getUser()`, and the
  refresh is **scoped to that agent's own `agent_id`**, taken from the verified
  token and never from the request body. Returns the refreshed registration row
  and number rows so the wizard can re-render without racing its own writes.

Turning the platform gate back on here would break the cron sweep. The browser
path is safe either way because it re-verifies the JWT internally regardless.

### Post-approval auto-assign

`a2p-register` tells the agent *"we will assign your texting number
automatically once it is approved"*, and `telnyx-buy-number` made that true for
a number bought **after** approval. Nothing made it true for the far more
common order: **buy a number, then get approved days later.** That agent's
registration reached `approved` and stopped — no textable number and no button
to press.

`a2p-status-poll` now attempts one assignment per agent that polls as approved,
deliberately conservative:

- only when the agent owns **exactly one** active number, and
- none is already assigned or `PENDING_ASSIGNMENT`.

With several numbers, picking one would be choosing their public texting
identity for them — the wizard shows a picker for that case instead.
`assignAgentNumberToCampaign` re-checks every precondition and is idempotent,
so repeated runs cost nothing.

---

## Local click-through (`serve.ps1`) — the CORS gate

`serve.ps1` serves `http://localhost:8080`, which is not in
`_shared/cors.ts`'s shipped `ALLOWED_ORIGINS`, so every `functions.invoke`
would fail its preflight. Reads go through PostgREST and were never affected.

`cors.ts` now carries a **separate, env-gated** `DEV_ORIGINS` set
(`http://localhost:8080`, `http://127.0.0.1:8080`). It is **off unless
`ALLOW_DEV_ORIGINS` is explicitly truthy**, and fails closed on a missing or
unreadable env var. They are deliberately NOT in `ALLOWED_ORIGINS` — that set
is what ships; allowing a dev origin should always be a deliberate, visible,
revocable act.

```bash
supabase secrets set   ALLOW_DEV_ORIGINS=true    # enable for a local pass
supabase secrets unset ALLOW_DEV_ORIGINS         # turn it back off
```

There is only ONE Supabase project, so while this is on, localhost origins are
accepted against production data. **Turn it off when the click-through is
done.** Responses carry `X-Dev-Origins-Allowed: true` while it is on, so the
answer to "is it still enabled?" is a curl, not a guess:

```bash
curl -s -i -X OPTIONS \
  https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/a2p-register \
  -H "Origin: http://localhost:8080" -H "Access-Control-Request-Method: POST" \
  | grep -i "access-control-allow-origin\|x-dev-origins"
```

Verified live 2026-07-28: localhost reflected on redeployed functions; a stray
origin (`https://evil.example.com`) **not** reflected, falling back to the
apex; the apex itself unchanged.

Only the six functions the texting UI invokes were redeployed with the new
`cors.ts` — `a2p-register`, `a2p-verify-otp`, `a2p-status-poll`,
`a2p-assign-number`, `messaging-consent-record`, `messaging-send-sms`. The
other 43 that import `cors.ts` still carry the old allowlist and will reject
localhost until they are redeployed; that was a deliberate blast-radius
choice, not an oversight.

## Deploy

Nothing here has been deployed. Both functions need pushing, and
`app.html` is served by GitHub Pages from the repo root so it ships on commit.

```bash
# per-function, never a bare batch deploy — see the header of supabase/config.toml
supabase functions deploy a2p-status-poll --no-verify-jwt
supabase functions deploy messaging-inbound-webhook --no-verify-jwt
supabase functions deploy messaging-consent-record

# opt-in page (2026-07-28). APPLY 20260733_sms_optin_consent.sql FIRST — the
# form renders without it and every submission fails on a missing column.
supabase functions deploy compliance-page --no-verify-jwt
supabase functions deploy messaging-send-optin-invite

# then re-check verify_jwt per function (a batch deploy took four functions
# dark for five hours on 2026-07-09)
supabase functions list
```

`compliance-page` must come back **verify_jwt = false**, and
`messaging-send-optin-invite` **true**. The trust subdomain also needs
`cd vercel-trust && vercel --prod` for the `form-action 'self'` CSP change —
without it the opt-in form is served but the browser silently refuses to
submit it.

`a2p-status-poll` must come back **verify_jwt = false** and
`messaging-consent-record` **true**. Confirm the browser path answers:

```bash
# with a real session JWT — expect {"ok":true,"scope":"agent",...}
curl -s -X POST https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/a2p-status-poll \
  -H "Authorization: Bearer <user access token>" -H "Content-Type: application/json" -d '{}'
```

**No schema changes were required for the three surfaces above.** Every column
they read already existed in production — audited read-only 2026-07-28, see
`docs/schema-state.md`. The opt-in page that came later DOES need one:
`supabase/migrations/20260733_sms_optin_consent.sql`, still pending apply.

---

## Not built (deliberately out of scope)

- The default campaign library and drip sequences — separate work.
- MMS in the composer. `messaging-send-mms` exists and respects the same gate;
  the thread renders `mms` rows but has no attachment picker.
- A global inbox. Threads are per-lead. An inbound message that still cannot be
  attributed after all four resolution passes lands with
  `inbound_messages.agent_id = null` and is invisible to every agent. Its
  **opt-out is still honoured** (see below), but the message itself is not
  shown to anyone.
- Full message bodies. Logged in `docs/schema-state.md` § "Known gaps —
  logged 2026-07-28, deliberately NOT built". (Evidence-grade consent was on
  that list too and is now **built** — see the campaign-rejection section
  above.)

---

## 🔴 Fixed in this batch — unattributed STOP was silently dropped

`messaging-inbound-webhook` gated its entire opt-out block on the agent match:

```ts
if (isOptOut && agentId) {        // <- the bug
  await sb.from("dnc_list").insert({ ... });
  await fetch(/* confirmation */);
}
```

When the destination number could not be attributed, `agentId` was `null` and
**no `dnc_list` row was written and no confirmation was sent.** The only trace
was `inbound_messages.is_opt_out = true` — and nothing reads that column.
`dnc_list` is the single enforcement point: `runComplianceGate()` checks it for
every 1:1 send and every broadcast recipient. A STOP that writes no `dnc_list`
row is a STOP we did not hear.

**This was live, not theoretical.** Audited 2026-07-28: the Telnyx fleet held
**8** DIDs, `public.phone_numbers` held **6**. Missing from both
`phone_numbers` and `agents.signalwire_caller_id`:

| Number | What it is |
|---|---|
| `+12029703699` | the **shared caller ID leads actually see** on outbound calls |
| `+12625099123` | the 262 dialer host |

A consumer replying STOP to either — and 970-3699 is the number most likely to
receive a reply, because it is what shows on their phone — was not recorded as
opted out, got no confirmation, and remained textable by every agent.

(There are no drip sequences in the codebase, so nothing needed cancelling.)

### The fix

**Resolve harder, then honour the opt-out regardless.**

1. exact `phone_numbers.e164` (unchanged; `e164` is UNIQUE so this cannot be ambiguous)
2. **new** — last-10 match against `phone_numbers.e164`, for format drift
3. **new** — *the conversation itself*: the most recent outbound `messages` row where we texted **this contact** **from this number**. A STOP is a reply to something we sent, so the outbound leg names the agent even when the number inventory does not. Both sides are matched, so it cannot attribute the opt-out to the wrong agent when two agents have messaged the same consumer.
4. legacy `agents.signalwire_caller_id` last-10 (unchanged)

Then `if (isOptOut)` — no agent condition:

- agent known → per-agent `dnc_list` row, as before;
- agent unknown → **global** row (`agent_id = null`), which
  `runComplianceGate` already honours for every agent
  (`r.agent_id === null || r.agent_id === agentId`), plus a loud
  `*** UNATTRIBUTED OPT-OUT ***` log naming the number to add to inventory;
- **the confirmation reply is sent either way** — it is owed to the consumer,
  not to the agent;
- a unique violation on the insert is the desired end state (already listed);
  any other error logs `*** FAILED TO RECORD OPT-OUT ***`.

The global fallback is deliberately broader than necessary: it stops *every*
agent texting that one consumer. With four resolution passes in front of it,
it only fires for a number we genuinely cannot attribute, and over-blocking one
contact is the correct side to fail on when the alternative is ignoring a STOP.

The response body now returns `agent_matched`, `matched_by` and `dnc_scope` so
this is visible in the Telnyx webhook log rather than only in ours.

**Still outstanding (not a code fix):** `+12029703699` and `+12625099123` are in
the Telnyx fleet but not in `public.phone_numbers`. They are shared
infrastructure rather than agent-owned DIDs, so inserting rows for them means
inventing an owner — left for a deliberate decision. The resolver and the
global fallback handle them correctly in the meantime.
