# A2P 10DLC campaign — prepared draft (NOT SUBMITTED)

**Status: REJECTED once, rebuilt, not yet resubmitted.** See "Rejection and
what changed" at the foot of this file. The old blocker — waiting on GoatLeads'
verbatim consent wording — is **closed**, not because the wording arrived but
because it turned out to be the wrong thing to wait for.

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

**Opt-in message**

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

**This is the field the rejection was about.** It is generated, not hand-typed:
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

## Rejection and what changed

**The first submission was rejected.** The ground: carrier review would not
accept a lead vendor's "and its licensed agents" language as opt-in evidence
for a campaign sending as Frenkel Financial Agency. A generic reference to
unnamed downstream agents is not consent for a specific named sender.

The previous blocker on this file was a request to GoatLeads for their exact
on-form wording, on the theory that quoting it verbatim would beat
paraphrasing it. **That theory is dead.** The problem was never the fidelity of
our quote; it was that the consent is not ours to rely on. GoatLeads will not
change their form, and no amount of exact quotation turns a generic
downstream-agent clause into named-sender consent.

### What replaced it

Frenkel Financial Agency now collects its own SMS consent, on its own page:

```
https://trust.producerstackcrm.com/a/frenkel-financial-agency/sms-opt-in
```

Server-rendered, no JavaScript, a single never-pre-checked checkbox, and the
full disclosure inline beside it. Every submission stores the exact disclosure
displayed, the page URL, the IP, the user agent, the timestamp, and the name
typed. Built in `docs/compliance-pages.md` § "The SMS opt-in page".

The lead vendor still explains where the lead came from — it is still named in
the privacy policy, and the description above still says the consumer
consented there **to telephone and email**. That is accurate, and it is all
that consent ever supported.

### Before resubmitting

- [ ] `supabase/migrations/20260733_sms_optin_consent.sql` applied
- [ ] `compliance-page` deployed with `--no-verify-jwt`, and `vercel-trust`
      redeployed so the CSP carries `form-action 'self'` — with `'none'` the
      browser silently refuses to submit the form and nothing logs anywhere
- [ ] All four URLs return `200 text/html`: `""`, `/privacy-policy`,
      `/terms`, `/sms-opt-in`
- [ ] A real POST to `/sms-opt-in` returns `303` and writes a
      `consent_method='web_form'` row with a populated `disclosure_text`
      (curl block in `vercel-trust/README.md`)
- [ ] The disclosure on the live page matches the quote above **word for
      word** — a reviewer will compare them, so compare them first
- [ ] Brand `website` field set to the privacy policy URL
- [ ] At least one real opt-in captured, so the campaign describes something
      that has actually happened rather than something that could

**$15 per submission, and resubmission after a rejection is another $15.** One
rejection has already been paid for.
