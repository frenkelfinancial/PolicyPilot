# A2P 10DLC campaign — prepared draft (NOT SUBMITTED)

**Status: BLOCKED — do not submit.** See "Blocker" at the foot of this file.

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
```

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

## Blocker — awaiting GoatLeads consent wording

The **opt-in workflow description** is the one field still unfinished. It has to
describe, in the carrier reviewer's terms, exactly how the consumer consented —
and the strongest version of that quotes the lead vendor's on-form disclosure
**verbatim** rather than paraphrasing it.

- Requested from **GoatLeads**: their exact consumer consent disclosure wording.
- Email sent **2026-07-28**. Awaiting reply.
- Until it arrives, `disclosure` stays `null` in
  `supabase/functions/_shared/lead-vendors.ts` and the description falls back to
  our paraphrase. **Do not fill it with an approximation** — a reviewer
  comparing the description against the vendor's live form and finding a
  mismatch is the fastest route to a rejection, and a rejection costs another
  $15 to retry.

### Do not submit until

- [ ] GoatLeads' exact disclosure wording received and pasted verbatim into
      `lead-vendors.ts`
- [ ] Opt-in workflow description regenerated from it and re-read end to end
- [ ] Both compliance URLs confirmed live (200, `text/html`) — see the curl
      block in `docs/compliance-pages.md` § 4
- [ ] Brand `website` field set to the privacy policy URL

**$15 per submission, and resubmission after a rejection is another $15.**
