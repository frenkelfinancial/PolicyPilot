# trust.producerstackcrm.com

A thin Vercel project whose only job is to serve each agent's 10DLC compliance
pages on a domain that belongs to us:

```
/a/:slug                            ->  compliance-page edge function
/a/:slug/privacy-policy
/a/:slug/terms
/a/:slug/sms-opt-in                 GET (form) and POST (records consent)
/a/:slug/sms-opt-in/confirmed
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
server-rendered HTML with one inline `<style>` and no scripts, images, or
external requests, so `style-src 'unsafe-inline'` plus `img-src data:` is
everything they need.

### 🔴 `form-action 'self'` — do not put this back to `'none'`

It was `'none'` until the SMS opt-in page shipped, which was correct while
every page was read-only. It is now load-bearing: `/a/:slug/sms-opt-in` posts
a real form back to itself, and `form-action 'none'` makes the browser
**silently refuse to submit it** — no error, no request, no network entry. The
page looks fine and the button does nothing. Nothing else on the page changes,
so this is very easy to reintroduce and very hard to spot.

`'self'` is the tightest value that works: the form may post to
`trust.producerstackcrm.com` and nowhere else, which is exactly the rule we
want on a page that collects a consumer's phone number.

Verify it after any change to this file:

```bash
curl -sI https://trust.producerstackcrm.com/a/<slug>/sms-opt-in \
  | grep -io "form-action [^;]*"          # expect: form-action 'self'
```

## Setup

```bash
cd vercel-trust
vercel link                                    # create a NEW project
vercel --prod
vercel domains add trust.producerstackcrm.com
```

Then add the DNS record Vercel prints at the registrar holding
`producerstackcrm.com`. Vercel now issues a **project-specific** CNAME target,
not the generic `cname.vercel-dns.com`. For this project it is (live, verified
2026-07-28):

```
trust    CNAME    2518311f49185490.vercel-dns-017.com
```

`producerstackcrm.com` also runs a wildcard record that 302s every unset
subdomain to a registrar parking page; the explicit `trust` record above wins
for that one name. The apex records pointing at GitHub Pages are untouched;
this only adds a subdomain.

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

### The opt-in form specifically

A rewrite must forward `POST` with its body intact, which is the one thing
about this project that was never exercised before the opt-in page. Check it
end to end rather than assuming:

```bash
# 1. the form renders, is a real POST form, and the box is NOT pre-checked
curl -s https://trust.producerstackcrm.com/a/<slug>/sms-opt-in \
  | grep -o 'method="post"\|name="consent"[^>]*'
#   expect: method="post"  and  name="consent" value="yes"  with NO `checked`

# 2. a submission redirects (303) rather than rendering the form again
curl -si -X POST https://trust.producerstackcrm.com/a/<slug>/sms-opt-in \
  --data-urlencode "first_name=Test" \
  --data-urlencode "last_name=Person" \
  --data-urlencode "phone=<a number you own>" \
  --data-urlencode "consent=yes" \
  | head -5
#   expect: HTTP/2 303  +  location: /a/<slug>/sms-opt-in/confirmed?...

# 3. and it wrote an evidence-grade row (SQL editor)
#   select consent_method, page_url, ip_address, left(disclosure_text, 60)
#     from consent_records order by captured_at desc limit 1;
```

A `405` on step 2 means the rewrite is not forwarding POST. A `200` with the
form HTML means a field was rejected — the error is rendered in the page body.

If `content-type` still comes back `text/plain`, Vercel is passing the origin
header through instead of overriding it. Fallback: replace the rewrite with a
small serverless function that fetches the Supabase URL and re-emits the body
with an explicit `text/html` header. That is fully under our control and cannot
be overridden by the origin. A Supabase custom domain (paid add-on) would also
remove the sanitisation at source.
