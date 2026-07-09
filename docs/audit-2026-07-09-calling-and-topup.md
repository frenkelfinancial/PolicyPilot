# Audit — "Simulated token error" + Stripe "Failed to fetch" (2026-07-09)

## The two symptoms are one root-cause family

Both errors are **network-level failures**: the user's browser never reached the Supabase edge functions at all.

- "Simulated — token error": in the softphone, `sb.functions.invoke('telnyx-webrtc-token')` returns a `FunctionsFetchError` when the request is blocked before reaching the server (CORS rejection, ad-blocker, firewall). That error has no response body, so the client labeled it with the generic fallback `token_error` and dropped into stub mode.
- "Failed to fetch" on top-up: `pbConfirmAddFunds()` does a raw `fetch()` to `stripe-create-checkout`. A blocked request throws `TypeError: Failed to fetch`, which was shown to the user verbatim.

Same user, same session, both requests blocked → both symptoms together. Other users on a different origin/network are fine → "works for some, not others."

## Bug 1 — Inconsistent CORS allowlists across edge functions (primary)

Every edge function hand-rolls its own CORS. They disagree:

| Function | Allowed origins (before fix) |
|---|---|
| telnyx-webrtc-token, wallet-hold-call, telnyx-report-call-minutes, messaging-*, telnyx-buy/release/replace/search-numbers, a2p-*, gmail-*, parse-email, match-events | apex + `https://localhost` |
| **stripe-create-checkout** | **apex only** — hardcoded header, no allowlist |
| stripe-billing-config, stripe-cancel-subscription, stripe-agency-unlink, itk-quote, itk-companies, uw-chat, telnyx-dialer-create-session, telnyx-provision-number, telnyx-set-cnam, signalwire-* | apex only |

Consequences:

- **Any user not on exactly `https://producerstackcrm.com` fails.** That includes `https://www.producerstackcrm.com` and the Capacitor mobile app (origin `https://localhost` — allowed for calling but **not** for checkout, so mobile users could never top up even with current code).
- Note: `https://www.producerstackcrm.com` currently returns an **empty page** (fetched twice today). If any user bookmarks/lands on www, the app is broken outright. Check the Vercel domain config — www should 308-redirect to apex.
- Ad-blockers/corporate firewalls that block `*.supabase.co` produce the identical pair of symptoms. Worth asking the affected user to try incognito with extensions off.

## Bug 2 — Version skew: three different app builds are live simultaneously

This is the biggest "works for some users, not others" generator:

| Entry point | File served | State |
|---|---|---|
| `producerstackcrm.com/app.html` | `app.html` | Current: wallet, top-up UI, per-call holds, minute billing, granular error reasons |
| `producerstackcrm.com/` | `index-github-latest.html` (via vercel.json rewrite) | **Old full app.** Dials via `telnyx-webrtc-token`, but has **no `wallet-hold-call` and no `telnyx-report-call-minutes`** — its calls are never held or billed (revenue leak). It also labels *every* token failure as `token_error`, so a 402 `insufficient_balance` or 400 `no_caller_id` from the token endpoint renders as "Simulated — token_error: …". A low-balance user on this bundle sees exactly the reported behavior. It has no Add-funds UI either. |
| Mobile app (`www/` bundle) | `www/index.html` / `www/app.html` | **Even older**: no wallet code at all; its Power Dialer invokes `telnyx-dialer-create-session` etc., which are apex-only CORS → broken from the app's `https://localhost` origin. |

Users who log in from the homepage run the old bundle; users who go to `/app.html` run the new one. Fix: make `/` serve the current app (or a thin landing page that links to `/app.html`), retire `index-github-latest.html`, and rebuild `www/` (`npx cap sync`) from the current `app.html`.

## Bug 3 — Server-side per-user gates that legitimately block calls

`telnyx-webrtc-token` refuses a session when:

- `agents.signalwire_caller_id` is NULL and `TELNYX_BROWSER_CALLER_ID` is unset → 400 `no_caller_id` (agent has no number assigned), or
- wallet balance < `billing_config.min_call_start_mills` (default 30 mills) → 402 `insufficient_balance`.

The current `app.html` shows proper toasts for both; the old bundles show them as "token error." For the affected user, check those two DB fields first — low balance + inability to top up (Bug 1/2) is a fully self-consistent explanation of his report.

## Fixes applied in this session

1. `supabase/functions/stripe-create-checkout/index.ts` — replaced the hardcoded apex-only CORS header with the same origin allowlist as the calling functions (apex, www, `https://localhost`), added `Allow-Methods`/`Vary`, per-request headers.
2. `supabase/functions/telnyx-webrtc-token/index.ts`, `wallet-hold-call/index.ts`, `telnyx-report-call-minutes/index.ts` — added `https://www.producerstackcrm.com` to the allowlists.
3. `app.html` — `_initTelnyxWebRTC` now detects `FunctionsFetchError` and reports reason `network` with an actionable message (check connection/ad-blocker/URL) instead of the misleading `token_error`; `pbConfirmAddFunds` translates raw "Failed to fetch" into the same actionable message.

Note: `telnyx-report-call-minutes/index.ts` was restored from git HEAD (bae7a74) before re-patching due to a file-sync glitch during editing; if it had uncommitted local changes, review with `git diff` before deploying.

## To go live

1. `supabase functions deploy stripe-create-checkout telnyx-webrtc-token wallet-hold-call telnyx-report-call-minutes`
2. Redeploy the site so the updated `app.html` ships.
3. Decide on Bug 2: point `/` at the current app and rebuild the mobile `www/` bundle — until then, homepage users keep making unbilled calls and seeing "token error" for balance problems.
4. Fix the www subdomain (redirect to apex) in Vercel/DNS.
5. Longer term: extract one shared `_shared/cors.ts` and use it in every function — the apex-only stragglers (itk-quote, uw-chat, stripe-billing-config, telnyx-dialer-*, etc.) will break the mobile app the moment its bundle is updated.

## For the specific affected user, in order

1. Ask what URL/app he's on (`/` vs `/app.html` vs mobile app) — likely the old bundle or www.
2. Check `agents.signalwire_caller_id` and `wallet_accounts.balance_mills` for his account.
3. Have him try `https://producerstackcrm.com/app.html` in an incognito window with extensions disabled — if both features work there, it was origin/ad-blocker, confirming Bug 1/2.
