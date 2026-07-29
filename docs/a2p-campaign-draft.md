# A2P 10DLC campaign — LIVE, `CD2166Q`, with open review items

**Status as of 2026-07-28T21:xxZ: the campaign EXISTS, is `ACTIVE`, and has
already been paid for.** It is not a draft and not a dead rejected record.
Three review items came back from the carrier; **one is fixed, two are open.**

| | |
|---|---|
| Telnyx campaign ID | `4b30019f-a9df-e17b-3529-70677db27ec4` |
| TCR campaign ID | `CD2166Q` |
| Status | `ACTIVE` |
| Billed | `2026-07-28` — the $14.50 is **already spent** |
| Use case | `LOW_VOLUME` · `CUSTOMER_CARE`, `MARKETING`, `ACCOUNT_NOTIFICATION` |
| Brand | `4b20019f-a5df-2721-e3c1-cea9522125a0` (`BBTQ508`), `identityStatus: VERIFIED` |

> 🔴 **Do not create a second campaign without checking whether this one can be
> updated.** A new campaign is another $14.50 AND leaves two campaigns on one
> brand. `CD2166Q` is `ACTIVE`, so the fields the carrier objected to
> (`optinMessage`, `messageFlow`) are candidates for an in-place update, which
> is normally free. That has NOT been tested yet — see "What to do next".

Read this whole file before touching the campaign. Sections "Carrier review
items" and "🔴 The vendor in this repo is the wrong company" are the two that
change what you would otherwise do.

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

> 🔴 **The opt-in message below is the one the carrier objected to (review
> items 2 and 3).** It is reproduced as the CURRENT live value, not as a
> target. It never mentions marketing or promotional messages while the
> campaign declares `MARKETING`. Do not copy it forward — rewrite it first.

**Opt-in message** — ❌ live value, needs replacing

> Frenkel Financial Agency: You're subscribed to messages about your life insurance quote, appointments, and application status. Msg frequency varies. Msg&data rates may apply. Consent is not a condition of purchase. Reply HELP for help, STOP to opt out.

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

**These do not go in a campaign link field — there isn't one.** Probed against
live Telnyx 2026-07-28: `campaignBuilder` silently discards unknown fields, and
every spelling of `privacyPolicyLink` / `termsAndConditionsLink` was discarded.
`termsAndConditions` is a real field but it is a **boolean attestation**, not a
link. The URLs reach the reviewer by two verified routes only:

1. the **brand's `website`** field, and
2. the free-text **opt-in workflow description** (`messageFlow`), which names
   both URLs in prose.

Full probe results: `docs/compliance-pages.md` § "How the URLs actually reach
the carrier", and the field-name block at the top of
`supabase/functions/_shared/telnyx-10dlc-adapter.ts`.

---

## Opt-in workflow description (`messageFlow`)

> 🔴 **The text below names GoatLeads and Built Leads, which are the WRONG
> vendors** — see "The vendor in this repo is the wrong company". It is kept
> here as the record of what this repo currently generates, NOT as text to
> submit. Regenerating after the vendor fix will change it (and its length).

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
console.log(buildOptinDescription("Frenkel Financial Agency", ["goatleads","builtleads"], u));
'
```

> Consumers request life insurance information through a web form operated by GoatLeads and Built Leads, a licensed lead provider, and consent there to be contacted by telephone and email. That form is NOT the basis for text messages. Consent to receive text messages is collected separately, on Frenkel Financial Agency's own opt-in page at https://trust.producerstackcrm.com/a/frenkel-financial-agency/sms-opt-in, which the agency sends to the consumer by email or reads to them by phone. On that page the consumer enters their first name, last name, and mobile number, and must tick a single checkbox that is never pre-checked. The full disclosure is displayed inline beside the checkbox, not behind a link or pop-up, and reads: "By checking this box, I agree to receive text messages from Frenkel Financial Agency at the mobile number I provide above. Messages may include marketing, customer care, and account notifications about my insurance quote, appointments, and application status. Message frequency varies. Message and data rates may apply. Consent is not a condition of purchase. I can reply STOP at any time to opt out, or HELP for help. See Frenkel Financial Agency's privacy policy at https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy and text messaging terms at https://trust.producerstackcrm.com/a/frenkel-financial-agency/terms." On submission the agency stores the consumer's name and mobile number, the exact disclosure text above, the date and time, the consumer's IP address, and the page URL. The consumer is then sent this campaign's registered opt-in confirmation message. The agency sends no text message to any number without a stored consent record of this kind. Consumers may reply STOP at any time to opt out, or HELP for help.

**1,783 characters** against TCR's 2,048 limit. `submitCampaign()`
refuses to post anything longer — see `TCR_MESSAGE_FLOW_MAX` in
`_shared/lead-vendors.ts`. If it ever needs shortening, **cut the fixed prose,
never the quoted disclosure**: the quote matching the live page word for word
is the entire point of it.

Note what it no longer says. It does not claim the GoatLeads form is consent
for texting, it does not quote their disclosure, and it does not lean on
TrustedForm for SMS. It names a page a reviewer can open and check against
every sentence in it.

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

### Which of the three are fixed

| # | Item | State |
|---|---|---|
| 1 | Opt-in evidence must identify **Frenkel** as the sender | ✅ **FIXED** |
| 2 | Opt-in auto-response needs updating per Telnyx's keywords article | ❌ **OPEN** |
| 3 | `MARKETING` selected but the opt-in auto-response never mentions marketing or promotional messages | ❌ **OPEN** |

**Item 1** is what the hosted opt-in page was built for. Consent is now
collected on `/a/frenkel-financial-agency/sms-opt-in`, a page branded to
Frenkel, whose disclosure names Frenkel as the sender and is stored verbatim
per submission. Live and verified — see `docs/compliance-pages.md`.

**Items 2 and 3 are untouched, and item 3 is the dangerous one.**
`buildOptInAutoResponse()` in `supabase/functions/_shared/sms-optin.ts`
produces a string that is **character-identical** to the live `optinMessage`
the carrier just objected to (verified by direct comparison, 2026-07-28):

```
Frenkel Financial Agency: You're subscribed to messages about your life
insurance quote, appointments, and application status. Msg frequency varies.
Msg&data rates may apply. Consent is not a condition of purchase. Reply HELP
for help, STOP to opt out.
```

It contains no marketing or promotional language. Resubmitting as-is
reproduces the exact defect that was cited. **That string has to change before
anything is submitted**, and because it is quoted verbatim inside the campaign
`messageFlow`, changing it changes both.

---

## 🔴 The vendor in this repo is the wrong company

**The carrier's file says the opt-in disclosure belongs to *The Veteran
Resource Center*.** The live campaign's `messageFlow` names
`https://theveteranresourcecenter.com/vrc-v4` as the lead form.

**This repo says GoatLeads and Built Leads, everywhere, and that is wrong.**
`LEAD_VENDORS` in `supabase/functions/_shared/lead-vendors.ts` lists those two;
the generated privacy policy's "Where your information comes from" section
names them; the generated campaign description names them. Confirmed
2026-07-28: the description this repo generates says "operated by GoatLeads and
Built Leads" and never mentions The Veteran Resource Center.

**Decision (Jace, 2026-07-28): GoatLeads and Built Leads were wrong and are
being removed.** The Veteran Resource Center is the real source.

Why this matters more than a name: the privacy policy and the campaign opt-in
description are required to tell the *same* story, and the carrier already has
the true one on file. Submitting a description naming two companies the
reviewer has never seen — while the disclosure they inspected belongs to a
third — is a fresh mismatch of exactly the kind that produced item 1.

### Not yet changed in code

The vendor correction is **documented here but NOT applied**. It was left
deliberately: editing `LEAD_VENDORS` changes the live generated privacy policy
and the campaign description together, and both are carrier-facing, so it
should be one deliberate change followed by a redeploy and a re-read — not a
side effect of a documentation pass.

Files that carry the wrong vendor and need it:

- `supabase/functions/_shared/lead-vendors.ts` — `LEAD_VENDORS` (source of truth)
- `supabase/functions/_shared/compliance-page.test.ts` — fixtures + assertions
- `supabase/functions/_shared/a2p-registration.test.ts` — fixtures
- `app.html` — the composer's vendor dropdown labels (`vendorLabel`)
- `public.agents.lead_vendors` for the Frenkel agent row (data, not code)
- `scripts/a2p-phase2-smoke.ts` — fixture

---

## What to do next

In order. Nothing below has been done.

1. **Rewrite the opt-in auto-response** to name marketing/promotional messages
   explicitly, following
   <https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages>.
   One string, `buildOptInAutoResponse()`. Closes items 2 and 3. Free.
2. **Correct the vendor** to The Veteran Resource Center across the files
   listed above, so the policy, the page and the description agree with the
   carrier's file. Free.
3. **Redeploy** `compliance-page` and re-verify the live opt-in page still
   matches the quoted disclosure byte for byte (there is a check for this).
4. **Establish whether `CD2166Q` can be updated in place** — `PUT`/`PATCH` on
   `/v2/10dlc/campaign/{id}` with the new `optinMessage` and `messageFlow`.
   If it can, the fix is **$0**. Only if it cannot does a new campaign at
   **$14.50** become necessary.
5. Re-run the `messageFlow` length check (`TCR_MESSAGE_FLOW_MAX`) and confirm
   both compliance URLs return `200 text/html` before any submission.

### Pre-flight results, 2026-07-28 (both passed, recorded so they are not re-derived)

| Check | Result |
|---|---|
| Generated `messageFlow` length | **1783 / 2048** — pass |
| `/a/frenkel-financial-agency/privacy-policy` | `200 text/html; charset=utf-8` |
| `/a/frenkel-financial-agency/terms` | `200 text/html; charset=utf-8` |

These passed against the description that still names the **wrong vendors**, so
step 2 will change the length. Re-run it.

---

## 🔴 Nothing in the app is watching this campaign

`a2p-status-poll` will **not** pick up status changes for `CD2166Q`. Verified
2026-07-28.

The poller sweeps `public.a2p_registrations`:

```ts
sb.from("a2p_registrations")
  .select("agent_id, brand_id, campaign_id, status")
  .in("status", ["pending", "approved"])
  .not("brand_id", "is", null)
  .not("campaign_id", "is", null)
```

**`a2p_registrations` has 0 rows.** `CD2166Q` was created outside this system —
through the Telnyx portal, not through `a2p-register` — so no registration row
exists for it, and the poller has nothing to match on. The campaign could be
approved, suspended or expired and the app would never notice.

Two consequences:

1. **Status changes must be checked by hand** (`GET /v2/10dlc/campaign?brandId=…`)
   until a registration row exists.
2. **Texting is blocked regardless of the campaign's state.**
   `runComplianceGate()` refuses every SMS unless
   `a2p_registrations.status = 'approved'` for the sending agent. With zero
   rows, that check can never pass — so even a fully approved `CD2166Q` would
   not enable a single text. A number also has to be attached
   (`phone_numbers.sms_capable`), and both of Frenkel's active numbers are
   currently `sms_capable = false`.

So the campaign being fixed is necessary but **not sufficient**. Closing the
loop needs an `a2p_registrations` row for the Frenkel agent carrying
`brand_id` + `campaign_id` + `status`, and a number assigned to the campaign.
Deciding whether to backfill that row by hand or re-run registration through
`a2p-register` is a separate call — note that `a2p-register` would try to
create a NEW brand/campaign and bill for it, which is not what is wanted here.

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

## Superseded: the GoatLeads blocker

Earlier revisions of this file blocked submission on obtaining GoatLeads'
verbatim on-form consent wording, to quote it in the opt-in description. That
is closed twice over:

1. the premise was wrong — a lead vendor's "…and its licensed agents" language
   is not opt-in evidence for a named sender no matter how exactly it is
   quoted, which is review item 1; and
2. **GoatLeads was never the vendor.** See above.

`lead-vendors.ts::disclosure` is therefore irrelevant to the SMS consent story.
Consent comes from the hosted opt-in page.
