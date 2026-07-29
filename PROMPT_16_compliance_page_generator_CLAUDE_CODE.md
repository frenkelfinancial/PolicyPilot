# PROMPT 16 — Per-agent compliance page generator

**Target:** Claude Code, ProducerStack repo
**Goal:** every agent gets a public, agent-branded privacy policy + terms + SMS disclosure at a stable URL, generated from data we already collect, with zero work on their part.
**Blocks:** PROMPT_15 Phase 2/4 — A2P brand and campaign registration cannot be submitted without these URLs.

---

## Why this exists

10DLC brand and campaign registration requires a publicly reachable privacy policy and terms page belonging to **the business sending the messages**. Not the lead vendor's — the vendor's policy describes what the vendor does with the data, and doesn't mention the agency at all. A carrier reviewer is answering one question: *"if I'm the consumer receiving this text, where do I learn who has my number and how to stop it?"*

> ⚠️ **HISTORICAL SPEC — superseded 2026-07-28. Do not implement the vendor
> parts of this document.** Two premises below turned out to be wrong: the
> named vendors were the wrong companies, and the lead vendor's consent is NOT
> a valid basis for text messages (carrier review item 1 on campaign CD2166Q
> refused it). `agents.lead_vendors` now holds lead source *categories* and no
> lead company is named on any carrier-facing surface. See `CLAUDE.md` and
> `docs/a2p-campaign-draft.md`.

Our agents are life insurance producers. They buy leads from vendors like GoatLeads and Built Leads, where the consumer gave prior express written consent certified by TrustedForm. Their consent story is fine. What they don't have — and reasonably never will — is a consumer-facing website. They're producers, not marketers. Most have no website at all, or a recruiting site aimed at other agents.

So ProducerStack generates the page. This is the difference between an agent registering for A2P in one click and an agent giving up.

This is the single highest-leverage compliance feature in the product. Build it carefully.

---

## Phase 1 — Discovery (do this first, report before coding)

Two things must be established before any implementation:

1. **What actually serves producerstackcrm.com?** The repo contains both a `CNAME` file and a `.vercel` directory. Determine which host is live. This decides the routing approach:
   - **Vercel** → add a rewrite from `/a/:slug/:page` to a serverless function or to the Supabase edge function. Best outcome: the compliance URL lives on the main domain.
   - **GitHub Pages or another static-only host** → the pages cannot be dynamic on the apex domain. Use a `trust.producerstackcrm.com` subdomain pointed at the Supabase edge function, or a Vercel project for that subdomain.
   - Do not generate and commit static HTML files per agent. That does not scale and couples agent signup to a deploy.

2. **Public access on Supabase edge functions.** The function must be reachable by an anonymous HTTP GET with no `Authorization` header — carrier reviewers use ordinary browsers and simple fetchers. Deploy with `--no-verify-jwt` and confirm a bare `curl` returns 200.

Report both findings and the chosen URL shape before writing the generator.

---

## Phase 2 — Data model

Migration `supabase/migrations/20260729_compliance_pages.sql`.

**`agents`** — add if not already present:
- `compliance_slug text unique` — URL segment, e.g. `frenkel-financial-agency`
- `compliance_page_published_at timestamptz`
- `lead_vendors text[]` — which vendors this agent buys from
- `dba_name text` — public-facing agency name, may differ from legal entity name

**`compliance_page_revisions`** — audit trail, append-only:
- `id`, `agent_id`, `rendered_at`, `inputs jsonb` (snapshot of every field used to render), `reason text`

Rationale: an approved campaign points at a URL. If an agent later edits their address, the page changes under an approved registration. We don't block that, but we keep a record of what the page said and when.

**Slug rules:**
- Derive from `dba_name`, falling back to legal business name: lowercase, strip accents and punctuation, spaces → hyphens, collapse repeats, trim to 60 chars
- On collision append `-2`, `-3`, …
- **Immutable once `a2p_registrations.status` has advanced past `not_started`.** Changing a registered URL breaks the campaign. Enforce this in a DB trigger, not just app code.

RLS: agents read and update their own row; only the service role writes revisions. Match the pattern in `20260709b_wallet_foundation.sql`.

---

## Phase 3 — The renderer

New edge function `compliance-page`.

**Routes** (final paths depend on Phase 1):
- `/a/:slug` — index: agency name, contact, one-line description, links to both policies
- `/a/:slug/privacy-policy`
- `/a/:slug/terms`

**Hard requirements:**
- **Server-rendered HTML only.** No client-side JavaScript, no framework hydration, no fetch-on-load. Some reviewers use tools that don't run JS. If the required text isn't in the raw HTML response, it doesn't exist.
- Returns 200 for a published agent, 404 with a plain page for unknown slugs
- No authentication of any kind
- `Cache-Control: public, max-age=300`
- Mobile-responsive, inline CSS, self-contained — same approach as the standalone files already in the repo
- Include `<meta name="robots" content="index,follow">`. A page that's indexable reads as a real business.

**Branding:** the page belongs to the agent. Their agency name is the headline, their address and phone are the contact block. ProducerStack appears only in a small footer line: *"This page is hosted by ProducerStack on behalf of [AGENCY NAME]."* Do not brand these as ProducerStack pages — that recreates the exact mismatch that got us here.

### Privacy policy — required content

The following paragraph must appear **verbatim**. It is the exact language carrier reviewers search for. Do not paraphrase, reflow, or "improve" it:

> Your mobile information will not be sold or shared with third parties for promotional or marketing purposes. No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Information sharing to subcontractors in support services, such as customer service and messaging delivery providers, is permitted. All other use case categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.

Also required, in the agency's voice:

- **Who we are** — agency name, that it is a licensed life insurance agency, contact details
- **Where your information comes from** — this section must match the campaign's opt-in description. Template:
  > We receive your contact information when you request life insurance information through a web form operated by one of our licensed lead partners ([VENDOR LIST]). Those forms capture your consent to be contacted by phone and text message by licensed insurance agents, including [AGENCY NAME]. Consent is certified by TrustedForm, which records your IP address, session activity, timestamp, and the exact disclosure shown to you. We retain that certificate for each person we contact.
- **Text messaging** — what we send (quote follow-up, appointment reminders, application status, customer service); message frequency varies; message and data rates may apply; consent is not a condition of purchase; reply STOP to opt out, START to resubscribe, HELP for help; carriers not liable for undelivered messages
- **How we use information** — quoting, applications, servicing, scheduling, legal recordkeeping
- **Who we share with** — carriers and underwriters, service providers under contract, regulators where required; never mobile numbers or SMS consent data for third-party marketing
- **Security, retention, and your rights** — access, correction, deletion, do-not-contact
- **Children** — not for anyone under 18
- **Contact** — agency email, phone, city/state

### Terms — required content

- Agency is not a carrier; no guarantee of coverage or rates; quotes are estimates subject to underwriting
- Not financial, tax, or legal advice
- Full SMS program section mirroring the privacy policy's messaging terms
- Recorded calls disclosure
- Accuracy of information provided
- Disclaimer and limitation of liability
- Governing law — **use the agent's state**, not a hardcoded Wisconsin
- Contact block

Both pages carry a visible "Last updated" date driven by the latest revision.

### Sole proprietors

Many agents have no LLC. When there is no legal entity:
- Headline is the agent's DBA or their own name
- Omit entity-specific language ("a Wisconsin limited liability company")
- Contact block still needs a real physical address — required for registration regardless

---

## Phase 4 — Generation flow

- Generate automatically at signup completion, as soon as business name, address, phone, and email are present. The agent never requests this.
- Regenerate on any change to those fields, writing a `compliance_page_revisions` row.
- Add a read-only panel in Settings showing the two live URLs with copy buttons, a preview link, and last-updated. Frame it plainly: *"These pages let you register for text messaging. Carriers require them. We keep them current for you."*
- If a required field is missing, show exactly which one and link to the field — do not silently skip generation.

**Wire into PROMPT_15:** `a2p-register` must refuse to submit when `compliance_page_published_at` is null, with error `compliance_page_missing`. Pass the privacy policy URL as the brand's `website` field and both URLs into the campaign's compliance link fields. Replace the `TODO(PROMPT_16)` marker left in that work.

---

## Phase 5 — Reusable opt-in description

Add a shared helper that builds the campaign opt-in workflow description from the agent's vendor list. One well-written description, reused for every agent, so it only has to survive carrier review once:

> Consumers request life insurance information by completing a web form operated by [VENDOR], a licensed lead provider. Before submitting, the consumer provides prior express written consent to be contacted by telephone and SMS by licensed insurance agents, including [AGENCY NAME]. Consent is captured and certified by TrustedForm, which records the consumer's IP address, session activity, timestamp, and the exact disclosure language displayed. The TrustedForm certificate is delivered with each lead and retained by [AGENCY NAME]. [AGENCY NAME] does not send messages to any lead without a stored consent record. Consumers may reply STOP at any time to opt out.

Keep the vendor list in a small config with a display name and public form URL per vendor (GoatLeads, Built Leads, plus an "Other" free-text path). When we learn a vendor's exact disclosure wording, store it there so the description can quote it.

---

## Do not do

- Do not render any part of the required text with JavaScript
- Do not put ProducerStack's name in the headline or make the page look like our marketing site
- Do not reuse producerstackcrm.com's own privacy policy for an agent — that document describes a software company messaging its users, which is a different business from an agency messaging consumers
- Do not let the slug change after A2P submission
- Do not paraphrase the mobile-information paragraph
- Do not gate these pages behind auth, a cookie banner, or a redirect

---

## Test plan

1. **Anonymous fetch** — `curl` both URLs with no headers; expect 200 and the required paragraph present in the raw HTML
2. **No-JS render** — fetch with JavaScript disabled; every required section still present
3. **LLC agent** — full entity language, correct state in governing law
4. **Sole proprietor** — no entity language, page still complete and coherent
5. **Awkward business name** — apostrophes, ampersands, accents: slug is clean, HTML is escaped, no injection
6. **Slug collision** — two agents with the same agency name get distinct working URLs
7. **Slug lock** — attempting to change a slug after A2P submission is rejected at the database level
8. **Regeneration** — change the agent's address, confirm the page updates and a revision row is written
9. **404** — unknown slug returns a clean 404, not a stack trace
10. **Registration gate** — an agent with no published page cannot submit A2P, and the error names the missing field
11. **Mobile** — both pages readable on a phone

---

## Definition of done

A new agent finishes signup, and without taking any action has two live, publicly reachable, agent-branded policy URLs that satisfy carrier review — and A2P registration picks them up automatically.
