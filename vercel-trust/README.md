# trust.producerstackcrm.com

A thin Vercel project whose only job is to serve each agent's 10DLC compliance
pages on a domain that belongs to us:

```
/a/:slug                  ->  compliance-page edge function
/a/:slug/privacy-policy
/a/:slug/terms
```

It is a **separate Vercel project** from the repo-root one (`policy-pilot`).
Run every command below from inside this directory, never from the repo root.

## Why this project exists at all

Two independent reasons, both verified against production on 2026-07-28:

**1. `producerstackcrm.com` is GitHub Pages, serving the repo root.** It is
static-only, so it cannot render per-agent pages. Generating and committing
static HTML per agent was rejected — it couples agent signup to a deploy.

**2. Supabase sanitises HTML on its own domain, so the raw function URL is
unusable as a compliance URL.** Every `GET` returning HTML from
`*.supabase.co` comes back as:

```
Content-Type: text/plain
Content-Security-Policy: default-src 'none'; sandbox
```

A carrier reviewer opening that link sees raw HTML source, not a policy page.
This is Supabase's anti-phishing protection on their shared domain, it is
platform-wide (`summary-unsubscribe` has always behaved this way), and it is
not something the function can opt out of. Note that `curl -I` hides it —
`HEAD` returns the correct `text/html`, only `GET` is coerced. Test with
`curl -i`, not `curl -I`.

**So this project is load-bearing, not cosmetic.** The `headers` block in
`vercel.json` restores `Content-Type: text/html; charset=utf-8` on the way out,
which is what makes the pages actually render.

The CSP here is deliberately strict but not `sandbox`: the pages are pure
server-rendered HTML with one inline `<style>` and no scripts, images, forms,
or external requests, so `style-src 'unsafe-inline'` plus `img-src data:` is
everything they need.

## Setup

```bash
cd vercel-trust
vercel link                                    # create a NEW project
vercel --prod
vercel domains add trust.producerstackcrm.com
```

Then add the DNS record Vercel prints at the registrar holding
`producerstackcrm.com` — normally:

```
trust    CNAME    cname.vercel-dns.com
```

The apex records pointing at GitHub Pages are untouched; this only adds a
subdomain.

## Verify after DNS propagates

The content-type override is the thing most likely to need adjusting, so check
it explicitly with `-i` (a `GET`, not a `HEAD`):

```bash
curl -i https://trust.producerstackcrm.com/a/<slug>/privacy-policy | head -20
```

Required:

- `HTTP/2 200`
- `content-type: text/html; charset=utf-8`  ← **not** `text/plain`
- the mobile-information paragraph present in the raw body

```bash
curl -s https://trust.producerstackcrm.com/a/<slug>/privacy-policy \
  | grep -c "will not be sold or shared"        # expect 1
```

If `content-type` still comes back `text/plain`, Vercel is passing the origin
header through instead of overriding it. Fallback: replace the rewrite with a
small serverless function that fetches the Supabase URL and re-emits the body
with an explicit `text/html` header. That is fully under our control and cannot
be overridden by the origin. A Supabase custom domain (paid add-on) would also
remove the sanitisation at source.
