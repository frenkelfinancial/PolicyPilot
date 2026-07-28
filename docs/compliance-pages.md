# Per-agent compliance pages (PROMPT_16)

Every agent gets two publicly reachable, agent-branded policy URLs, generated
automatically from their business profile:

```
https://trust.producerstackcrm.com/a/<slug>                  overview
https://trust.producerstackcrm.com/a/<slug>/privacy-policy
https://trust.producerstackcrm.com/a/<slug>/terms
```

10DLC brand and campaign registration requires a privacy policy and terms page
belonging to the business sending the messages. The lead vendor's policy
describes the vendor and never mentions the agency; a recruiting site aimed at
other agents describes a different business again. Both fail carrier review.
Our agents are producers, not marketers — most will never have a consumer
website. So we generate the page, and `a2p-register` refuses to submit without
one.

---

## Why the pages are not on producerstackcrm.com

**The apex is GitHub Pages, serving the repo root of `main`.** Verified
2026-07-27:

```
$ curl -I https://producerstackcrm.com/
HTTP/1.1 200 OK
Server: GitHub.com
X-Served-By: cache-chi-klot8100110-CHI     # Fastly, GH Pages' CDN
```

Confirmed by byte-for-byte match: live `/app.html` is 2,134,597 bytes, exactly
the repo-root `app.html`. The `CNAME` file holds `producerstackcrm.com`.

Supporting facts:

- `.vercel/` contains only `repo.json` — a local `vercel link` artifact. There
  is no `project.json`, no `vercel.json` at the root, and `.vercel` is
  gitignored. **Nothing Vercel serves the apex.**
- `www/` is the Capacitor bundle. `scripts/prebuild.js` copies the root pages
  into it for the native shell; it is not the Pages source.
- There are no GitHub Actions workflows, so there is no build step to hook.

GitHub Pages is static-only, so per-agent pages cannot be dynamic on the apex.
Generating and committing static HTML per agent was rejected outright: it
couples agent signup to a deploy and does not scale.

**The chosen shape** is a thin Vercel project serving only
`trust.producerstackcrm.com`, rewriting `/a/*` to the Supabase edge function.
The URL stays inside the ProducerStack domain family, no per-agent deploy
exists, and the apex keeps working exactly as it does today.

---

## Public access on the edge function

The function must answer an anonymous GET with no `Authorization` header —
carrier reviewers use ordinary browsers and simple fetchers. Verified against
the live project:

| Function | Anonymous GET | Meaning |
|---|---|---|
| `summary-unsubscribe` (`verify_jwt = false`) | `400` from its own code | platform gate off, handler ran |
| `a2p-register` (platform default) | `401 UNAUTHORIZED_NO_AUTH_HEADER` | rejected before code runs |

`[functions.compliance-page] verify_jwt = false` is set in
`supabase/config.toml`. That file exists because a batch redeploy without the
flag took four functions dark for ~5 hours on 2026-07-09 — read its header
before touching any deploy command.

---

## Setup (one time)

### 1. Deploy the function

```bash
supabase functions deploy compliance-page --no-verify-jwt
supabase secrets set COMPLIANCE_PAGE_BASE_URL=https://trust.producerstackcrm.com
```

Verify it is genuinely public — **no headers at all**:

```bash
curl -i https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/compliance-page/a/<slug>/privacy-policy
```

Expect our own `404` page for an unknown slug (or `200` for a published one),
**not** `401 UNAUTHORIZED_NO_AUTH_HEADER`. A `401` means the flag did not take.
Confirmed 2026-07-28: `compliance-page` → 404, `a2p-register` (the control) →
401.

> **The raw supabase.co URL is not the compliance URL, and cannot be.**
> Supabase coerces every HTML `GET` on `*.supabase.co` to
> `Content-Type: text/plain` with `Content-Security-Policy: default-src 'none';
> sandbox` — anti-phishing protection on their shared domain, applied
> platform-wide (`summary-unsubscribe` has always behaved this way). A reviewer
> opening that link sees raw HTML source. `curl -I` hides this: `HEAD` returns
> the correct `text/html`, only `GET` is coerced, so always test with `curl -i`.
> Restoring the header is the job of the `headers` block in
> `vercel-trust/vercel.json`, which makes step 3 load-bearing rather than
> cosmetic.

### 2. Apply the migration

Paste `supabase/migrations/20260729_compliance_pages.sql` into the Supabase SQL
Editor and run it. **This project applies schema by manual paste, never
`db push`.** The file is idempotent and ends with a verification block.

### 3. Create the Vercel project for the subdomain

From `vercel-trust/` — this is a **separate** project from `policy-pilot`, so
do not run it from the repo root:

```bash
cd vercel-trust
vercel link          # create a NEW project, e.g. producerstack-trust
vercel --prod
vercel domains add trust.producerstackcrm.com
```

Then add the DNS record Vercel prints, at whatever registrar holds
`producerstackcrm.com`. **Vercel issues a PROJECT-SPECIFIC CNAME target now, not
the generic `cname.vercel-dns.com`** — use exactly what the dashboard shows for
this project. For the current trust project it is:

```
trust    CNAME    2518311f49185490.vercel-dns-017.com
```

(An older generic `cname.vercel-dns.com` also resolves for many projects, but
Vercel printed the project-specific `…vercel-dns-017.com` target here; that is
what is live.) Also note `producerstackcrm.com` runs a **wildcard** record that
catches every unset subdomain and 302s it to a registrar parking page
(`producerstackcrm-com.l.ink`) — the explicit `trust` CNAME above overrides the
wildcard for that one name. If `trust` ever regresses to the parking redirect,
the explicit record was dropped.

The apex `A`/`ALIAS` records pointing at GitHub Pages are untouched — this only
adds a subdomain.

### 4. Confirm end to end

Live as of 2026-07-28 — all three routes return `200` with
`content-type: text/html; charset=utf-8` (the Vercel header override defeating
Supabase's `text/plain` coercion), and an unknown slug returns `404`:

```bash
for p in "" /privacy-policy /terms; do
  curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
    "https://trust.producerstackcrm.com/a/frenkel-financial-agency$p"
done
# → 200 text/html; charset=utf-8   (×3)

curl -s "https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy" \
  | grep -c "will not be sold or shared"          # expect: 1

curl -s -o /dev/null -w "%{http_code}\n" \
  "https://trust.producerstackcrm.com/a/bogus-slug/privacy-policy"   # expect: 404
```

---

## How generation works

Generation is a **database trigger**, not an edge-function call, so it cannot
be skipped by any code path:

```
agents INSERT/UPDATE
  └─ agents_lock_compliance_slug        reject an illegal slug change
  └─ agents_protect_compliance_columns  revert client writes to derived cols
  └─ agents_protect_privileged_columns  (pre-existing)
  └─ agents_sync_compliance_page        allocate slug, publish, snapshot
  └─ agents_touch_updated_at            (pre-existing)
```

`agents_sync_compliance_page` fires when the business profile is complete —
name, street, city, state, ZIP, phone, email. It allocates a slug, stamps
`compliance_page_published_at`, and appends a row to
`compliance_page_revisions`. On later edits it appends another revision only if
the rendered inputs actually changed, so an unrelated `UPDATE` writes nothing.

The HTML is rendered live from the `agents` row on every request, so there is
nothing stale and no per-agent artifact to rebuild.

### Rules the database enforces, not app code

1. **The slug locks at registration.** Once `a2p_registrations.status` moves
   past `not_started`, changing `compliance_slug` raises. An approved campaign
   points at a literal URL; changing it silently 404s the compliance link and
   surfaces weeks later as unexplained message blocking.
2. **The page never unpublishes.** If a required field is later blanked, the
   page stays live on the last saved details. A reviewer following an approved
   campaign's link must never hit a 404.
3. **The client cannot write the slug.** `compliance_slug` and
   `compliance_page_published_at` sit on a row the agent already owns, so RLS
   does not protect them — a trigger reverts client writes, exactly as
   `20260703c_agents_column_protection.sql` does for `is_admin`.

---

## Rules for anyone editing the renderer

`supabase/functions/_shared/compliance-page.ts`:

1. **No client-side JavaScript, anywhere.** Not for a footer year, not for a
   nav toggle. Some reviewers use fetchers that never run JS; text that is not
   in the raw HTML does not exist for them. Enforced by unit test.
2. **`MOBILE_INFO_PARAGRAPH` is verbatim.** Carrier reviewers sometimes match
   it literally. Do not paraphrase, reflow, or split it across elements.
3. **The page belongs to the agent.** Their agency name is the headline;
   ProducerStack appears in exactly one footer line. Branding these as
   ProducerStack pages recreates the mismatch this feature exists to fix.
4. **`compliance_slugify()` in the migration and `slugifyAgencyName()` in the
   renderer must agree.** The TS version is what Settings previews; the SQL
   version is what gets stored and registered. A structural lockstep test
   guards this, but there is no local Postgres in this toolchain — if you
   change one, re-run the verification query in the migration footer.

---

## Tests

```bash
npm run test:compliance
```

45 unit tests cover slug rules, injection/escaping, the verbatim paragraph,
LLC vs sole-proprietor rendering, governing law, and the no-JS guarantee.

The cases that need a live deploy are listed in the setup steps above:
anonymous fetch, 404 on an unknown slug, slug lock rejection, regeneration
writing a revision row, and the `compliance_page_missing` registration gate.

---

## How the URLs actually reach the carrier

Probed against live Telnyx on 2026-07-28. **The Telnyx campaign has no
compliance-link field.** `campaignBuilder` silently ignores unknown fields —
confirmed with a deliberately bogus field name — so an earlier revision that
sent `privacyPolicyLink` / `termsAndConditionsLink` was a no-op: Telnyx
accepted the request and discarded them. Every spelling was tried
(`privacyPolicyURL`, `privacy_policy_link`, `privacyPolicyUrl`, …); all
ignored. `webhookURL` *is* recognised and errors with "Invalid URL" when
malformed, which is what proves the silence is real absence and not a lenient
validator.

So the URLs travel two verified routes instead:

| Route | Field | Verified how |
|---|---|---|
| Brand | `website` = the agent's privacy policy URL | errors "Invalid URL" on a bad value → field is real |
| Campaign | opt-in workflow text names both URLs | free-form string the reviewer reads |

`termsAndConditions` is a real campaign field but it is a **boolean
attestation**, not a link — do not put a URL in it.

The full probe results (which campaign fields are real, which are ignored) are
recorded in the field-name block at the top of
`supabase/functions/_shared/telnyx-10dlc-adapter.ts`.

> **Separate, pre-existing:** `submitCampaign` still posts to `/campaign`, but
> the real create is `/campaignBuilder`, and `messageFlow` is a required field
> it never sends. As written it cannot succeed. That is PROMPT_15 Phase 2 work
> and is not fixed here.

## Lead vendors

`supabase/functions/_shared/lead-vendors.ts` holds the vendor list and builds
the campaign opt-in workflow description. One well-written description is
reused for every agent, with only the vendor and agency name substituted, so
it has to survive carrier review once rather than once per agent.

The privacy policy's "Where your information comes from" section and the
campaign opt-in description both read from this file. **They must always name
the same vendors** — a reviewer comparing the two and finding a mismatch is the
fastest route to a rejection.

Each vendor has a `disclosure` field, currently `null`. When we obtain a
vendor's exact on-form consent wording (screenshot or TrustedForm certificate
replay), paste it in verbatim and the description will quote it directly, which
is materially stronger evidence than our paraphrase. Do not fill it with an
approximation.
