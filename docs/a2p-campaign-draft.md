# A2P 10DLC campaign — LIVE, `CD2166Q`, all three review items closed

**Status as of 2026-07-29T02:4xZ: all three carrier review items are fixed,
and the campaign was corrected IN PLACE for $0.** `campaignStatus` moved
`TELNYX_FAILED` → `TCR_ACCEPTED` on that update.

| | |
|---|---|
| Telnyx campaign ID | `4b30019f-a9df-e17b-3529-70677db27ec4` |
| TCR campaign ID | `CD2166Q` |
| `status` (lifecycle/billing) | `ACTIVE` |
| `campaignStatus` (review) | **`TCR_ACCEPTED`** — was `TELNYX_FAILED` |
| `submissionStatus` | `CREATED` |
| `isTMobileRegistered` | `false` — carrier registration still outstanding |
| Billed | `2026-07-28`, renews `2026-10-28`, `autoRenewal: true` |
| Use case | `LOW_VOLUME` · `MARKETING`, `CUSTOMER_CARE`, `ACCOUNT_NOTIFICATION` |
| Brand | `4b20019f-a5df-2721-e3c1-cea9522125a0` (`BBTQ508`), `identityStatus: VERIFIED` |

> ✅ **The in-place update works and costs nothing. `PUT /v2/10dlc/campaign/{id}`.**
> `PATCH` 404s (same as the brand). Verified 2026-07-29 — see "Updating the
> campaign in place" below. A second campaign was never needed and must not be
> created.

> 🔴 **`status: ACTIVE` is NOT the review status.** This campaign read
> `status: ACTIVE` while `campaignStatus` was `TELNYX_FAILED` — Telnyx's own
> vetting had failed and the app could not have known. Read `campaignStatus`
> and `failureReasons`, never `status`.

Read this whole file before touching the campaign.

---

## ⏳ Current wait state — 2026-07-29T03:2xZ

**Everything under our control is done. We are waiting on the mobile carriers,
and there is no action that shortens that.**

| | |
|---|---|
| `campaignStatus` | `TCR_ACCEPTED` |
| `isTMobileRegistered` | `false` |
| Blocked on | carrier registration of `CD2166Q` |
| Assignment today | **refused** — `400 code 10036`, "still pending and has not been approved yet" |

Re-checked twice ~25 minutes apart on 2026-07-29 with no change. `a2p-status-poll`
runs hourly, so the app will notice the flip on its own. **The signal to watch is
`isTMobileRegistered` going `true`** (and `campaignStatus` reaching `ACTIVE`):

```bash
curl -s -H "Authorization: Bearer $TELNYX_API_KEY" \
  https://api.telnyx.com/v2/10dlc/campaign/4b30019f-a9df-e17b-3529-70677db27ec4 \
  | grep -o '"campaignStatus":"[^"]*"\|"isTMobileRegistered":[a-z]*'
```

### Next actions, in order

1. **When `isTMobileRegistered` flips `true`, assign `+12029981783`** and
   confirm `phone_numbers.sms_capable` goes `true`.
   - That number is both `agents.signalwire_caller_id` and `is_primary`, so
     rules 1 and 2 of `resolveTextingNumber()` agree on it.
   - It is already attached to the "Jarvis" messaging profile, which is a hard
     prerequisite and was the one thing missing.
   - **Auto-assign will NOT do this for you** — it requires the agent to own
     exactly one active number and there are two (`+12026143091` is the other).
     Use the picker in Settings → Texting.
   - Assignment usually returns `PENDING_ASSIGNMENT`; `a2p-status-poll`'s
     confirmation pass flips it to `ASSIGNED` and sets `sms_capable` within the
     hour. `sms_capable` is deliberately NOT set while pending.

2. **Wait out carrier propagation — 24–72h from the moment it reads
   `ASSIGNED`**, not from assignment submission. A failed test send at hour two
   is expected, not broken.

3. **Send an end-to-end test text.** The target is already prepared: a live
   `consent_records` row exists for **`+19204169244`** (Jace's own mobile),
   captured `2026-07-28T19:26Z` via the hosted opt-in page — `express_written`
   + `web_form`, unrevoked, and `dnc_list` is empty. It is the only contact
   currently textable, and it is the correct one for this test because the
   consent behind it is the evidence-grade kind the campaign describes.
   - Send it from the lead row's **Text** button so the whole gate runs.
   - Send inside 8am–9pm at the recipient's local time — quiet hours are
     enforced server-side (`_shared/tcpa.ts`) and will refuse otherwise, for
     free, with its own sentence.

### What is NOT waiting on the carriers

Nothing else. All three review items are closed, the compliance pages are live
and byte-verified, the registration row exists and polls `approved`, and no
further spend is required — the campaign is paid through `2026-10-28`.

---

This is the campaign prepared for our own verified production brand. It existed
only in a chat transcript until now; it is recorded here so the exact approved
wording survives, because **each submission costs $15 — including every
resubmission after a rejection.** Getting it right the first time is worth more
than getting it in early.

Not to be confused with the per-agent campaigns `a2p-register` submits. This one
is Frenkel Financial Agency's own campaign, on the production brand.

---

## Brand

| | |
|---|---|
| Brand | **Frenkel Financial Agency** |
| Telnyx brand ID | `4b20019f-a5df-2721-e3c1-cea9522125a0` |
| Environment | Production |
| Status | Verified (`identityStatus: VERIFIED`) |

See `docs/telnyx-10dlc-brands.md` for the sandbox counterpart and the standing
rule that all dev/test traffic goes to the **sandbox** brand, never this one.

## Campaign configuration

| Field | Value |
|---|---|
| Use case | Low Volume Mixed |
| Sub-use cases | Marketing · Customer Care · Account Notification |
| Vertical | Insurance |

### Keywords

| | |
|---|---|
| Opt-in | `START`, `YES`, `UNSTOP` |
| Opt-out | `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` |
| Help | `HELP`, `INFO` |

### Keyword responses

**Opt-in message** — ✅ live as of 2026-07-29, closes review items 2 and 3

> Frenkel Financial Agency: You're subscribed to marketing and promotional messages, customer care, and account notifications about your insurance. Msg frequency varies. Msg&data rates may apply. Consent is not a condition of purchase. Reply HELP for help, STOP to opt out.

271 characters. Generated by `buildOptInAutoResponse()` in
`_shared/sms-optin.ts` and verified byte-for-byte against the live campaign.
It carries all seven elements Telnyx's keywords article requires: brand name,
the use cases, frequency, rates, consent-not-a-condition, HELP, STOP.

**It must keep naming marketing/promotional for as long as `MARKETING` is in
`subUsecases`** — that agreement is review item 3. Capped at
`TCR_KEYWORD_MESSAGE_MAX` (320) because it grows with the agency name; a
60-character name lands at 308.

The string it replaced, which the carrier objected to, was:

> ~~Frenkel Financial Agency: You're subscribed to messages about your life insurance quote, appointments, and application status. …~~

A unit test asserts that string cannot come back.

**Opt-out message**

> Frenkel Financial Agency: You are unsubscribed and will receive no further messages. Reply START to resubscribe.

**Help message**

> Frenkel Financial Agency: For help call (920) 422-7733 or email jace@frenkelfinancial.com. Msg&data rates may apply. Reply STOP to opt out.

### Sample messages

**Sample 1 — Marketing**

> Hi John, this is Jace with Frenkel Financial Agency following up on the life insurance quote you requested. I can pull rates from several carriers for you - want me to send a few options? Reply STOP to opt out.

**Sample 2 — Account Notification**

> Hi John, Frenkel Financial Agency here - your life insurance application moved to Approved. I'll call today to walk you through the next steps. Reply STOP to opt out.

**Sample 3 — Customer Care**

> Hi John, Frenkel Financial Agency - thanks for sending your ID. Your policy documents are ready. Reply YES and I'll email them over, or call (920) 422-7733. Reply STOP to opt out.

### Attributes

| Attribute | Value |
|---|---|
| Embedded link | No |
| Embedded phone number | Yes |
| Number pooling | No |
| Age-gated content | No |
| Direct lending / loan arrangement | No |

### Compliance URLs

```
https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy
https://trust.producerstackcrm.com/a/frenkel-financial-agency/terms
https://trust.producerstackcrm.com/a/frenkel-financial-agency/sms-opt-in
```

The third is new, and it is the one a reviewer will actually test — it is the
page the opt-in workflow description below describes. It must return `200`
with `text/html`, show the disclosure in the raw body, and accept a POST
before this campaign goes anywhere.

> ⚠️ **Correction, 2026-07-29.** The live `CD2166Q` **does** carry
> `privacyPolicyLink` and `termsAndConditionsLink`, both populated with the
> trust-subdomain URLs, and they survived the `PUT`. So the flat claim below —
> "there is no compliance-link field" — is wrong for a campaign created in the
> **Telnyx portal**. What was actually proven on 2026-07-28 is narrower and
> still true: **`POST /campaignBuilder` discards those fields**, so a campaign
> created through *our* code cannot set them. Keep sending the URLs in
> `messageFlow` regardless — that is the route that works on both paths.

**These do not go in a campaign link field set by `campaignBuilder` — it has
none.** Probed against live Telnyx 2026-07-28: `campaignBuilder` silently
discards unknown fields, and every spelling of `privacyPolicyLink` /
`termsAndConditionsLink` was discarded. `termsAndConditions` is a real field
but it is a **boolean attestation**, not a link. The URLs reach the reviewer by
two verified routes only:

1. the **brand's `website`** field, and
2. the free-text **opt-in workflow description** (`messageFlow`), which names
   both URLs in prose.

Full probe results: `docs/compliance-pages.md` § "How the URLs actually reach
the carrier", and the field-name block at the top of
`supabase/functions/_shared/telnyx-10dlc-adapter.ts`.

---

## Opt-in workflow description (`messageFlow`)

**This is the field review item 1 was about.** It is generated, not hand-typed:
`buildOptinDescription()` in `supabase/functions/_shared/lead-vendors.ts`
builds it, quoting `buildOptInDisclosure()` from `_shared/sms-optin.ts`
verbatim. Reproduced here so the exact submitted wording survives outside a
transcript. **Regenerate rather than edit it here** if the code changes:

```bash
node --input-type=module -e '
import { buildOptinDescription } from "./supabase/functions/_shared/lead-vendors.ts";
import { compliancePageUrls } from "./supabase/functions/_shared/compliance-page.ts";
const u = compliancePageUrls("https://trust.producerstackcrm.com", "frenkel-financial-agency");
console.log(buildOptinDescription("Frenkel Financial Agency", u));
'
```

✅ **Live on `CD2166Q` since 2026-07-29**, verified byte-for-byte against a
fresh `GET`:

> Consumers request life insurance information through web forms and referrals, and consent there to be contacted by telephone and email. Those forms are NOT the basis for text messages. Consent to receive text messages is collected only on Frenkel Financial Agency's own opt-in page at https://trust.producerstackcrm.com/a/frenkel-financial-agency/sms-opt-in, which the agency sends to the consumer by email or reads to them by phone. It is the sole way a mobile number enters this campaign. On that page the consumer enters their first name, last name, and mobile number, and must tick a single checkbox that is never pre-checked. The full disclosure is displayed inline beside the checkbox, not behind a link or pop-up, and reads: "By checking this box, I agree to receive text messages from Frenkel Financial Agency at the mobile number I provide above. Messages may include marketing, customer care, and account notifications about my insurance quote, appointments, and application status. Message frequency varies. Message and data rates may apply. Consent is not a condition of purchase. I can reply STOP at any time to opt out, or HELP for help. See Frenkel Financial Agency's privacy policy at https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy and text messaging terms at https://trust.producerstackcrm.com/a/frenkel-financial-agency/terms." On submission the agency stores the consumer's name and mobile number, the exact disclosure text above, the date and time, the consumer's IP address, and the page URL. The consumer is then sent this campaign's registered opt-in confirmation message. The agency sends no text message to any number without a stored consent record of this kind. Consumers may reply STOP at any time to opt out, or HELP for help.

**1,785 characters** against TCR's 2,048 limit (2,007 for the worst-case
60-character agency name). `submitCampaign()` refuses to post anything longer
— see `TCR_MESSAGE_FLOW_MAX` in `_shared/lead-vendors.ts`. If it ever needs
shortening, **cut the fixed prose, never the quoted disclosure**: the quote
matching the live page word for word is the entire point of it.

Note what it no longer says. **It names no lead company at all**, it does not
claim any lead form is consent for texting, it does not quote a third party's
disclosure, and it does not lean on TrustedForm. It names a page a reviewer can
open and check against every sentence in it, and says in as many words that the
page is the only route into the campaign.

The text it replaced was **not** the repo-generated one — it was hand-written
in the Telnyx portal, and it did all four of those things. It is preserved
under "What the live campaign used to say" below, because it is the specimen
review item 1 was written about.

The confirmation message is deliberately **not** quoted in this field. It is
submitted on the same campaign as `optinMessage` (see "Keyword responses"
above), which is where the reviewer reads it — quoting it twice cost ~280 of
the 2,048 characters to say something they are already looking at. Both come
from `buildOptInAutoResponse()`, so they cannot disagree.

---

## Carrier review items — verbatim

Retrieved live from `GET /v2/10dlc/campaign?brandId=…` on 2026-07-28. This is
the carrier's own text, reproduced exactly. Do not paraphrase it when acting on
it — the wording is the specification.

> Who is the perceived sender of the messages? If it's a business using your
> platform, then each business will need a brand and campaign created
> specifically for them.
>
> Note: The live opt-in disclosure and SMS Terms are for The Veteran Resource
> Center and its licensed agents, while this campaign sends as Frenkel
> Financial Agency. The opt-in evidence must clearly identify Frenkel Financial
> Agency as the sender/perceived sender or otherwise establish direct
> Frenkel-branded consent at the point of opt-in.
>
> Subscriber/Auto-response Opt-in Message needs updating with information
> provided here -
> https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages
>
> Note: MARKETING is selected, but the START/opt-in auto-response does not
> explicitly mention marketing or promotional messages.

### All three are now fixed

| # | Item | State |
|---|---|---|
| 1 | Opt-in evidence must identify **Frenkel** as the sender | ✅ **FIXED** 2026-07-28 |
| 2 | Opt-in auto-response needs updating per Telnyx's keywords article | ✅ **FIXED** 2026-07-29 |
| 3 | `MARKETING` selected but the opt-in auto-response never mentions marketing or promotional messages | ✅ **FIXED** 2026-07-29 |

`campaignStatus` moved `TELNYX_FAILED` → `TCR_ACCEPTED` on the update that
closed 2 and 3, which is Telnyx agreeing.

**Item 1** is what the hosted opt-in page was built for. Consent is now
collected on `/a/frenkel-financial-agency/sms-opt-in`, a page branded to
Frenkel, whose disclosure names Frenkel as the sender and is stored verbatim
per submission. The campaign `messageFlow` now describes that page and no
longer describes anyone else's form.

**Items 2 and 3 were one defect stated twice** — the auto-response
under-declared what the campaign sends. Both closed by rewriting
`buildOptInAutoResponse()` (see "Keyword responses" above) and PUTting it onto
the live campaign.

> `failureReasons` still carries the original three-item text after the update.
> It is a historical record, not a live state — read `campaignStatus`.

---

## The lead-company problem, and how it was actually resolved

**The carrier's file said the opt-in disclosure belonged to *The Veteran
Resource Center*.** The live campaign's hand-written `messageFlow` named
`https://theveteranresourcecenter.com/vrc-v4`, quoted VRC's disclosure, and
argued that Frenkel "is one of the licensed insurance agents … covered by that
consent". That argument is precisely what review item 1 refused.

**This repo, separately, said GoatLeads and Built Leads** — two companies that
appear nowhere on the carrier side.

### The decision (2026-07-29): name NO lead company anywhere

Not "swap in the right name". Three reasons, in order of weight:

1. **Naming any lead company in an SMS-consent document points the reviewer at
   that company's disclosure**, which is the document that produced item 1. The
   remedy for "your opt-in evidence is someone else's" is not a better citation
   of someone else — it is our own evidence, standing alone.
2. **VRC's consent covers phone and email, not texting as Frenkel.** Naming
   them in the campaign description would re-assert a link we have just spent
   two surfaces breaking.
3. **It does not scale and it decays.** Every agent buys from someone
   different and they switch; a company name published on a compliance page is
   wrong the day that happens.

So `agents.lead_vendors` now holds **source categories** (`lead_partners`,
`own_forms`, `referrals`), the privacy policy describes lead sources by type
and says on the page why it does not list companies, and
`buildOptinDescription()` **lost its `vendorKeys` parameter** so a name cannot
be reintroduced without a signature change.

VRC is not named on any carrier-facing surface. It stays recorded *here*,
because knowing which company the reviewer's note referred to is what makes
that note legible later.

### Applied 2026-07-29

- `supabase/functions/_shared/lead-vendors.ts` — `LEAD_SOURCE_CATEGORIES` replaces `LEAD_VENDORS`
- `supabase/functions/_shared/compliance-page.ts` — policy renders categories; the unfounded TrustedForm retention claim removed
- `supabase/functions/_shared/compliance-page.test.ts` / `a2p-registration.test.ts` — fixtures, plus two new sweeps asserting no company name reaches any surface
- `app.html` ×4 — Settings checkboxes, the profile loader, the profile saver, and the composer's attestation field (now free text)
- `www/app.html`, `www/index.html` — via `npm run prebuild`
- `supabase/migrations/20260729_compliance_pages.sql` — column comment
- `supabase/migrations/20260734_lead_source_categories.sql` — the data migration
- `scripts/a2p-phase2-smoke.ts` — fixture
- `PROMPT_16_…md` — superseded banner

---

## Updating the campaign in place — verified $0, 2026-07-29

**`PUT /v2/10dlc/campaign/{campaignId}` works. `PATCH` returns 404** (`10005
Resource not found`) — the same asymmetry as the brand endpoint.

`PUT` replaces, so the safe procedure is the brand one: `GET` the campaign,
echo back every currently-set field except the server-managed ones, change only
what you mean to, `PUT` that, then diff before/after.

Server-managed (do NOT echo): `campaignId`, `tcrCampaignId`, `tcrBrandId`,
`cspId`, `status`, `campaignStatus`, `submissionStatus`, `createDate`,
`billedDate`, `nextRenewalOrExpirationDate`, `mock`, `failureReasons`,
`isTMobileRegistered`, `isTMobileSuspended`, `isTMobileNumberPoolingEnabled`,
`referenceId`, `resellerId`, `brandDisplayName`.

Whole-object diff after the real update — **exactly four fields moved**:

| Field | Before | After |
|---|---|---|
| `campaignStatus` | `TELNYX_FAILED` | **`TCR_ACCEPTED`** |
| `messageFlow` | the hand-written VRC text (1,508) | generated, 1,785 |
| `optinMessage` | the objected-to string (252) | the new one (271) |
| `subUsecases` | `[CUSTOMER_CARE, MARKETING, ACCOUNT_NOTIFICATION]` | same set, reordered |

`billedDate`, `nextRenewalOrExpirationDate`, `autoRenewal`, `tcrCampaignId`,
`campaignId`, `brandId`, `cspId`, `createDate` and `usecase` all unchanged.
**No charge**: `wallet_ledger` still holds 0 rows with `ref_type in
('a2p_brand','a2p_campaign')`, and Telnyx's `billedDate` did not move.

### Pre-flight results, 2026-07-28 (both passed, recorded so they are not re-derived)

| Check | Result |
|---|---|
| Generated `messageFlow` length | **1783 / 2048** — pass |
| `/a/frenkel-financial-agency/privacy-policy` | `200 text/html; charset=utf-8` |
| `/a/frenkel-financial-agency/terms` | `200 text/html; charset=utf-8` |

Superseded by the 2026-07-29 run below — those figures were measured against
the wrong-vendor description.

### Post-fix results, 2026-07-29

| Check | Result |
|---|---|
| Generated `messageFlow` length | **1,785 / 2,048** — pass (worst case 2,007) |
| Generated `optinMessage` length | **271 / 320** — pass (worst case 308) |
| Live `messageFlow` === `buildOptinDescription()` | byte-for-byte |
| Live `optinMessage` === `buildOptInAutoResponse()` | byte-for-byte |
| Live opt-in page disclosure === stored `disclosure_text` | byte-for-byte (641 chars) |
| `/a/frenkel-financial-agency` ×4 routes | `200 text/html; charset=utf-8` |
| Unknown slug | `404` |
| No lead company on any live page or in `messageFlow` | confirmed |

---

## ✅ The app is now watching this campaign

**Fixed 2026-07-29.** `a2p_registrations` held **0 rows**, so the poller had
nothing to match on and `runComplianceGate()` — which allowlists only
`status = 'approved'` — could never pass. Even a perfect `CD2166Q` enabled
exactly zero texts.

`supabase/migrations/20260735_backfill_frenkel_a2p_registration.sql` creates
the one missing row, pointing at the brand and campaign that already exist.
**Not via `a2p-register`**, which would have tried to create a second billable
pair.

It was inserted at `status = 'pending'` — deliberately never hand-stamped
`approved`, since that is the single value the send gate allowlists. The next
`a2p-status-poll` run read live Telnyx (`identityStatus: VERIFIED`,
`campaignStatus: TCR_ACCEPTED`) and promoted it itself: `{"approved":1}`.

> **The fee-guard columns are load-bearing.** `brand_fee_charged_at` and
> `campaign_fee_charged_at` are the only things stopping `advanceRegistration()`
> calling `wallet_debit`. Backfilling a row with them NULL would mean the next
> Retry press debits $4 + $14.50 for objects Jace already paid Telnyx for
> directly. They are set to Telnyx's own timestamps, and `business_info`
> records that the money moved on Telnyx's invoice and not through the wallet.

### What still blocks an actual text

| Gate | State |
|---|---|
| `a2p_registrations.status = 'approved'` | ✅ passes — but see the warning below |
| a `sms_capable` number | ❌ **0 of 2** — assignment is REFUSED BY TELNYX, see below |
| a `consent_records` row per recipient | 1 row exists; every other contact needs its own |

---

## 🔴 `TCR_ACCEPTED` is not assignable — and our status mapping doesn't know it

**Found live 2026-07-29, attempting the assignment.**
`POST /v2/10dlc/phone_number_campaigns` for `+12029981783` → `CD2166Q`:

```
400  code 10036  "Resource is being processed"
     "Campaign 4b30019f-a9df-e17b-3529-70677db27ec4 is still pending and has
      not been approved yet. Please try again once you've confirmed the
      campaign is in an approved state. This process can take time."
```

The campaign is `campaignStatus: TCR_ACCEPTED`, `isTMobileRegistered: false`.
TCR has accepted it; **the mobile carriers have not finished registering it.**
Assignment is impossible until they do, and that is pure waiting — there is no
action available to anyone.

This was previously recorded only for the *mock sandbox* brand (see
`docs/telnyx-10dlc-brands.md`, "mock brands can't be approved"). It is not a
mock-brand quirk. It applies to a real, paid, VERIFIED-brand campaign.

### The mapping is too optimistic

`normalizeStatus()` in `_shared/telnyx-10dlc-adapter.ts` maps **both**
`TCR_ACCEPTED` and `ACTIVE` to `approved`:

```ts
if (["VERIFIED","REGISTERED","TCR_ACCEPTED","APPROVED","ACTIVE"].includes(s)) return "approved";
```

So `a2p_registrations.status` reads `approved` while Telnyx will refuse every
assignment. Consequences today:

- the status wizard shows **"Carrier approved: complete"** when the carriers
  have not, in fact, finished;
- `runComplianceGate()`'s A2P check passes. Sends are still refused, but by the
  *next* gate (`no_sms_capable_number`), whose message — "attached to your
  approved 10DLC campaign… 24-72 hours to propagate" — is roughly true here, so
  this is not currently harmful; and
- `assignAgentNumberToCampaign()` passes its `status === 'approved'`
  precondition and calls Telnyx, which is where the 10036 surfaces.

**Not changed here**, because separating `TCR_ACCEPTED` from `ACTIVE` changes
what the send gate allowlists and what the wizard claims, and that is a
deliberate product decision rather than a cleanup. The candidate fix is a
distinct `carrier_pending` state between `pending` and `approved`. Logged as
checklist item 130.

### What WAS fixed: a transient refusal no longer strands the number

The dangerous part is fixed. `assignAgentNumberToCampaign()` used to send any
non-ok Telnyx result through `recordFailure()`, stamping
`a2p_assignment_status = 'FAILED_ASSIGNMENT'` — and `a2p-status-poll`'s
auto-assign pass **skips FAILED_ASSIGNMENT forever**, by design, on the
reasoning that carriers don't change their mind on a timer.

That reasoning is right for a real rejection and exactly wrong for a 10036. One
press of Assign a few hours too early would have permanently opted the number
out of the automation that would otherwise have assigned it, leaving a Retry
button for a condition retrying cannot fix.

`isTransientAssignmentError()` in `_shared/a2p-assign.ts` now classifies 10036
(and its prose) as a **precondition**, writing nothing and returning a plain
sentence. Verified: after the refused attempt, both numbers still read
`a2p_assignment_status: null` and the registration carries no
`assignment_failure_reason`. Two unit tests cover both directions.

### The chosen texting number, and the one thing that was done

**`+12029981783`** — it is both `agents.signalwire_caller_id` and
`is_primary`, so rules 1 and 2 of `resolveTextingNumber()` agree. Nothing was
recorded in the DB, because nothing was assigned.

One real change did land, at Telnyx: `+12029981783` had
`messaging_profile_id: null` and is now attached to the "Jarvis" profile
(`40019edb-…`). That is `ensureNumberOnMessagingProfile()`'s self-heal step, it
is free, and it is a hard prerequisite of assignment — so the number is now
ready the moment the carriers finish.

The auto-assign pass will **not** pick it up on its own: it requires the agent
to own exactly one active number, and there are two. Assignment needs one press
of the wizard's picker once `campaignStatus` reaches `ACTIVE` /
`isTMobileRegistered: true`.

---

## Brand `website` — changed 2026-07-28, and why it mattered

The brand's `website` was `https://frenkelfinancial.com`. That is a **live
agent-recruiting site**, titled *"Frenkel Financial Agency | Build Your Career
With Us"*. `docs/compliance-pages.md` names that exact case as one that fails
carrier review — a recruiting site describes a different business from the one
sending consumer texts — and the brand `website` field is one of only **two**
verified routes by which a compliance URL reaches a reviewer.

Now set to:

```
https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy
```

**Telnyx has no `PATCH` on `/v2/10dlc/brand/{id}`** — it returns `404`. The
update is a `PUT`, and a `PUT` with a partial body would null the fields it
omits on a **VERIFIED** brand. The safe procedure, used here: `GET` the brand,
echo back every currently-set field except the server-managed ones
(`brandId`, `tcrBrandId`, `cspId`, `identityStatus`, `status`, `createdAt`,
`updatedAt`, `mock`, `failureReasons`, `assignedCampaignsCount`,
`businessContactEmailVerifiedDate`, `universalEin`), change only `website`,
`PUT` that.

A whole-object before/after diff showed **exactly two fields changed**:
`website` and `updatedAt`. `identityStatus: VERIFIED`, `status: OK`,
`tcrBrandId` and the EIN were all preserved — no re-vetting triggered.

---

## What the live campaign used to say

Preserved because it is the specimen review item 1 was written about, and
because nothing else in the repo ever contained it — it was typed into the
Telnyx portal, not generated. Every emphasised claim below is one the fix
removed:

> Consumers request life insurance rate information on a web form operated by
> **The Veteran Resource Center**, a licensed lead partner, at
> https://theveteranresourcecenter.com/vrc-v4 . Before submitting, the consumer
> taps "See my rate" directly beneath this disclosure, shown in full on the
> form: "By tapping See my rate, you agree that **The Veteran Resource Center
> and its licensed agents** may contact you at the phone number and email above
> — including by autodialed calls, pre-recorded messages, and **recurring
> marketing/transactional SMS** — about insurance products, even if your number
> is on a DNC list. …" The linked SMS Terms are published at
> https://theveteranresourcecenter.com/tcpa-consent … **Frenkel Financial
> Agency is one of the licensed insurance agents that services these inquiries
> and is covered by that consent.** Consent is captured and certified by
> **TrustedForm** … the certificate is delivered with each lead and **retained
> by Frenkel Financial Agency**.

Read against the reviewer's note, the mismatch is plain: the consent artifact
is VRC's, the sender is Frenkel, and the bridge between them is an assertion we
made about someone else's wording.

The TrustedForm retention claim was also removed from the generated privacy
policy in the same change — it asserted we hold a certificate for every person
we contact, which is not true.

## Superseded: the GoatLeads blocker

Earlier revisions of this file blocked submission on obtaining GoatLeads'
verbatim on-form consent wording, to quote it in the opt-in description. That
is closed three times over:

1. the premise was wrong — a lead vendor's "…and its licensed agents" language
   is not opt-in evidence for a named sender no matter how exactly it is
   quoted, which is review item 1;
2. **GoatLeads was never the vendor**; and
3. no lead company is named on any carrier-facing surface at all now, so there
   is no field for such a quote to go in.

Consent comes from the hosted opt-in page.
