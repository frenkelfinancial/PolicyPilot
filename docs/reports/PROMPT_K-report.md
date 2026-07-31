# PROMPT K — Clean Stripe checkout finish

**Completed 2026-07-31.** Prompt: `prompts/PROMPT_K_stripe_success_page_CLAUDE_CODE.md`.
Page: `checkout-complete.html`. Function: `supabase/functions/stripe-create-checkout`.
Tests: `npm run test:checkout` (30). Suite: **1437 passing, 0 failing**.

## What was actually wrong

The owner described the popup redirecting into the full dashboard after a
purchase. Reading the code, that is two separate faults and the second is worse
than the first.

1. Every `success_url` pointed at `app.html?checkout=…`, so the return
   navigation loaded the entire CRM into a 540×760 popup.
2. **Two of the four return states had no handler at all.** app.html's
   `DOMContentLoaded` popup-close guard covered only `checkout=success` and
   `checkout=cancelled`. A wallet top-up returned `checkout=topup_success`,
   which matched no branch in that chain *and* was not in the guard — so it
   fell straight through to `applyTheme()` / `subscribeAuth()` and booted the
   whole app in the popup, where it stayed. `number_success` had the same hole.

The top-up path is the one an existing customer hits most often, and it was the
worst of the four.

## Inventory — every Stripe Checkout session creation in the repo

All three live in `supabase/functions/stripe-create-checkout/index.ts`. There
are no others (`grep` for `checkout/sessions` and `success_url` finds nothing
else outside build artifacts).

| # | Mode | Line | Old `success_url` | New | Old `cancel_url` | New | Live caller |
|---|---|---|---|---|---|---|---|
| 1 | `topup` (wallet) | 144 | `/app.html?checkout=topup_success&session_id={CHECKOUT_SESSION_ID}` | `/checkout-complete.html?type=topup` | `/app.html?checkout=cancelled` | `/checkout-complete.html?type=cancelled` | `pbConfirmAddFunds()` |
| 2 | `numbers` | 211 | `/app.html?checkout=number_success&session_id={CHECKOUT_SESSION_ID}` | `/checkout-complete.html?type=number` | `/app.html?checkout=cancelled` | `/checkout-complete.html?type=cancelled` | **none in app.html** — endpoint still reachable, no browser caller |
| 3 | subscription (default) | 354 | `/app.html?checkout=success&session_id={CHECKOUT_SESSION_ID}` | `/checkout-complete.html?type=subscription` | `/app.html?checkout=cancelled` | `/checkout-complete.html?type=cancelled` | `_openStripeCheckoutPopup()` ×2 — signup wizard and paywall |

All prefixed with `${APP_URL}` (default `https://producerstackcrm.com`).

**`{CHECKOUT_SESSION_ID}` was dropped.** The prompt allows it only if used to
pick the message; nothing reads it, the page grants nothing, and a session id
in a URL that buys nobody anything is worth removing rather than carrying.

## The page

`checkout-complete.html` — one file for all four states, because the notify /
auto-close / theme logic is identical and two copies of it is this repo's
recurring bug class. Only the copy differs.

| `?type=` | Headline | Line |
|---|---|---|
| `subscription` | Payment complete | Your plan is active. |
| `topup` | Payment complete | Funds added to your wallet. |
| `number` | Payment complete | Your new number is being set up. |
| `cancelled` | Checkout canceled | No charge was made. |
| anything else | Payment complete | You're all set. |

The default is deliberately vague rather than wrong — claiming a plan is active
when somebody topped up their wallet is worse than saying nothing specific.

**It grants nothing and verifies nothing.** No `fetch`, no Supabase client, no
session id, no API call of any kind — a test asserts all five. Fulfillment stays
100% on `stripe-webhook`. The page is safe to open by hand with any query string.

**Self-contained** — no stylesheet, script, font or image request. It lives for
about 2.5 seconds on the far side of a payment, and a blocked or slow asset is
the one thing that could leave it blank. The palette is copied from app.html's
`:root` / `body.light`, and the theme rule mirrors `applyTheme()` exactly
(`localStorage.pp_theme === 'dark'` → dark, everything else light, including
absent), so it cannot flash the wrong theme on the way out.

**Three notification channels**, because exactly one works in any given
situation and none works in all three:

- `window.opener.postMessage` — the ordinary popup
- `BroadcastChannel('pp_checkout')` — opener reference lost
- `localStorage.pp_checkout_signal` — every other tab, and browsers without
  BroadcastChannel

The payload is `{type:'pp_checkout_result', result, checkout, nonce}`. All three
firing is normal; `_ppSeenCheckout` dedupes by nonce so it is one toast, not
three.

**🔴 The legacy strings are sent narrowly, on purpose.**
`stripe_checkout_complete` drives `_wizPaymentComplete()` and
`_goToSuccessUrl()` — the signup wizard and the paywall. It fires only for
`type=subscription` (or blank, which historically was subscription). A wallet
top-up firing it would finish the signup wizard and walk somebody into the
dashboard on a plan they never bought.

**Auto-close after 2.5s**, then the close-blocked fallback. Detection is the
only portable signal there is: a window that actually closed stops running
timers, so a timer that fires *after* `window.close()` is proof it was refused.
The page then swaps "You can close this window" for a **Return to Producer
Stack →** button. Whatever happens, it cannot become a dashboard-in-a-popup —
there is no app in it to become one.

## The app side

One listener (`_ppListenForCheckout`), installed once, covering all three
channels and all three checkout kinds — rather than three listeners at three
popup-opening sites. It checks `e.origin === location.origin`, so a foreign
frame cannot fake a payment toast.

| Kind | What it refreshes |
|---|---|
| `topup` | `renderPhoneBook()` — re-reads `wallet_accounts` *and* the numbers, so one call covers the balance |
| `number` | `renderPhoneBook()` + `softphone.resetWebRTC()` |
| `subscription` | `_recheckSubscription()` — the path for a tab reloaded while checkout was open |

Plus the standard `Payment received` toast. A cancel is ignored here — the
opener already knows it opened one, and its own handler restores the button.

**The legacy guard was widened, not removed.** Stripe sessions created before
this deploy still carry the old URLs, so `?checkout=` handling stays — with
`topup_success` and `number_success` **added** to the popup-close guard they
were missing from. That closes the reported bug for in-flight checkouts too,
for one line. Those two report on the typed channel; only `success` /
`cancelled` send the legacy strings.

## Serving it

Two places had to learn about the new file, and missing either is silent:

- **`.github/workflows/pages.yml`** — the allowlist is default-deny. An
  unlisted page is not served, and a completed payment would land on a 404.
- **`scripts/prebuild.js`** — on native, hosted checkout opens in the system
  browser and returns here, so it ships in the bundle too.

Both are asserted by tests.

## Proof

| Claim | How it was verified |
|---|---|
| Type → message mapping | The `COPY` table is **extracted from the shipped file and executed** — the real table, not a copy |
| Opener payload shape | Source assertions on the single `payload` object and all three channels |
| Close-blocked fallback | CSS + the post-`close()` timer proof asserted in source |
| Deployed function carries the new URLs | `supabase functions download` round-tripped **byte-identical** to local |
| Nothing else in checkout moved | `git diff --stat` (below) + assertions that the product ids, price ids, `amount_mills` metadata and the cents conversion are all still present |

**No DOM-level proof was possible** — the repo has no jsdom or browser test
harness, and adding one for a 200-line static page was not worth it. No Stripe
test tooling is configured either (no `stripe` CLI, no test-mode keys in
`.env.local`), so **no test-mode checkout was run**. The two things not proven
mechanically are how the page actually paints and whether `window.close()`
succeeds in the owner's browser — both are step 1–5 of the checklist below.

## Scope guardrail — `git diff --stat`

```
 .github/workflows/pages.yml                        |  3 +
 app.html                                           | 95 +++++++++++++++++++++-
 package.json                                       |  5 +-
 scripts/prebuild.js                                |  4 +
 supabase/functions/stripe-create-checkout/index.ts | 25 ++++--
 www/app.html                                       | 95 +++++++++++++++++++++-
 www/index.html                                     | 95 +++++++++++++++++++++-
```

Plus new files `checkout-complete.html` and `test/checkout-complete.test.mjs`.
`www/*` are build artifacts from `npm run prebuild`.

**`stripe-webhook` is untouched.** So are `stripe-billing-config`,
`stripe-cancel-subscription`, `stripe-agency-unlink`, `stripe-create-promo`,
every `wallet-*` function, and every migration. The only billing-adjacent edit
is the six URL strings the prompt explicitly permits.

---

# 60-SECOND EYEBALL CHECKLIST

Steps 1–4 need no purchase — just open the URLs.

| # | Do this | Expect |
|---|---|---|
| 1 | Open `https://producerstackcrm.com/checkout-complete.html?type=topup` | Branded card, green tick, **"Payment complete / Funds added to your wallet."** Not a 404, not the dashboard |
| 2 | Same with `?type=subscription`, `?type=number` | "Your plan is active." / "Your new number is being set up." |
| 3 | Same with `?type=cancelled` | Grey **X**, "Checkout canceled / No charge was made." |
| 4 | Same with no param, and with `?type=garbage` | "Payment complete / You're all set." — never a wrong claim |
| 5 | Watch any of them for 3 seconds (opened directly, so close is blocked) | "You can close this window" is replaced by a **Return to Producer Stack →** button |
| 6 | Toggle the app's theme, reload the page | Follows it — dark app, dark page |
| 7 | In the app: Phone Book → **Add funds** → smallest amount → complete in test/live | Popup shows "Funds added to your wallet." and **closes itself** after ~2.5s |
| 8 | Look at the main tab immediately after | **"Payment received"** toast, wallet balance already updated — no manual reload |
| 9 | Start a checkout and press Stripe's back arrow instead of paying | Quiet "Checkout canceled" page, closes itself, no charge |
| 10 | Anywhere in the flow | You never see the dashboard inside the popup again |

If step 1 returns a 404, the GitHub Pages build has not finished yet — it runs
on push and takes a couple of minutes.

## Deliberately left

- **Two files, not one, for success and cancel** — rejected. One page with a
  `type` param keeps a single copy of the notify/close/theme logic.
- **No server-side session verification.** Explicitly out of scope, and the
  page is safer without it: it can grant nothing because it asks nothing.
- **The `numbers` checkout mode has no browser caller.** Its URLs were updated
  anyway (the prompt says update every one found), but nothing in app.html
  invokes `mode: 'numbers'` today. Not investigated further — outside this
  round's scope, flagged here because it looks live and is not.
- **`pp_pending_number_popup` is read but never written** in app.html — dead
  restore logic on the `number_success` path. Left alone for the same reason.
- **The native `browserFinished` flow is unchanged.** It cannot receive a
  postMessage from a system browser and already re-checks the server; the new
  page just gives it a clean terminal screen instead of a dashboard.
