# Security Notes

## 2026-06-17 — Audit & hardening pass

Full secret/leak scan of all tracked files + entire git history (86 commits):
**no leaked API keys, tokens, or private keys found.** The only client-side
credential (`index.html`) is the Supabase **publishable** key (`sb_publishable_…`),
which is designed for browser exposure and gated by RLS — not a leak.

Changes landed this pass:

- **CORS locked down.** All 8 browser-facing Edge Functions previously returned
  `Access-Control-Allow-Origin: *`. They now share `supabase/functions/_shared/cors.ts`,
  which reflects the request Origin back **only** when it is on the allowlist
  (`https://producerstackcrm.com`, its `www.`, the `*.github.io` Pages fallback,
  and localhost for dev), otherwise returns the canonical production origin.
  This is defense-in-depth on top of the existing per-function JWT check.
  The two server-to-server functions (`daily-digest` cron, `signalwire-call-status`
  webhook) are intentionally not browser-facing and carry no CORS.
  - ⚠️ **If the production domain changes**, update `ALLOWED_ORIGINS` /
    `PRIMARY_ORIGIN` in `_shared/cors.ts` and redeploy the functions, or browser
    calls will be blocked.

- **Pre-commit secret/PII guard added** at `.githooks/pre-commit`. Blocks commits
  containing high-signal secrets (API keys, tokens, PEM private keys) and CSVs
  with non-`@example.*` email addresses (a heuristic for a real client export
  accidentally dropped into `data/templates/`). Enable per clone with:
  ```
  git config core.hooksPath .githooks
  ```
  Bypass a verified false positive with `git commit --no-verify`.

### Residual / accepted risks

- **Session token in `localStorage`** (Supabase-JS default). Readable by any
  successful XSS. Moving it to httpOnly cookies requires a server/SSR layer this
  single-file static app does not have, so it is **accepted**; the real mitigation
  is XSS prevention (HTML-escaping on all `innerHTML` output, per the 2026-05-13
  audit). Same applies to the Google OAuth session.
- **Supabase project URL + publishable key are public** by design (RLS is the
  control surface). Ensure every table that holds agent/client data has RLS
  policies before it ships — see the Authentication note below.

## Authentication — Supabase Auth (in place)

`index.html` is gated by Supabase Auth. The login / sign-up / reset-password
panel is inline at the top of `<body>` (`#auth-gate`); the dashboard is
hidden until `onAuthStateChange` resolves a session.

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are pasted into the inline `<script>`
  block. The **anon key is RLS-safe to ship in client JS** — it has no
  privileges beyond what RLS policies on tables explicitly grant.
- Currently no application tables exist; auth is identity-only. Per-agent data
  (`ff_policies`, `pp_leads`, `ff_contract`) is namespaced in localStorage by
  the user's Supabase UID via the `k()` helper. When the data-sync portion of
  the upgrade roadmap lands, those keys move to RLS-protected tables.
- Sessions persist via Supabase's default localStorage adapter (auto-refresh
  tokens). Sign-out reloads the page to clear in-memory state.
- Password reset uses `supabase.auth.resetPasswordForEmail` with `redirectTo`
  set to the page itself — the recipient lands back in `index.html` with a
  recovery hash, which fires the `PASSWORD_RECOVERY` event and shows the
  reset view.

**Operator setup for the Supabase project:**
- In Auth → URL Configuration, add the deployed origin to "Site URL" and to
  "Redirect URLs" (otherwise reset emails won't return to the app).
- In Auth → Providers → Email, decide whether to require email confirmation
  (recommended ON for prod; can be off for dev).

## ✅ RESOLVED (2026-05-13) — AI Health Parser no longer calls Anthropic from the browser

> **Status: fixed.** The parser was migrated to the `anthropic-parse` Supabase
> Edge Function (Option A below). The browser now calls our own JWT-gated
> endpoint, which holds `ANTHROPIC_API_KEY` server-side. No Anthropic key is
> shipped in client JS. The historical analysis below is retained for context.

`index.html` line 987 *originally* called Anthropic's Messages API directly from the browser:

```js
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    ...
  })
});
```

Three problems:

1. **No `x-api-key` header.** The request will be rejected with 401.
2. **No `anthropic-version` header.** Required by the API.
3. **Model id is invalid.** `claude-sonnet-4-20250514` is not a public model id.
   The current Sonnet model is `claude-sonnet-4-6`.

Even if these were fixed by hardcoding a key, **shipping an Anthropic API key in
client-side JavaScript is a credential leak**. Anyone viewing source can use it.

### Two ways to fix

**Option A (recommended) — server proxy.** Stand up a tiny endpoint
(Cloudflare Worker, Vercel function, Supabase Edge Function) that holds the key
server-side, validates the request, and forwards to Anthropic. The browser
calls your endpoint, not Anthropic.

**Option B — bring-your-own-key.** Each agent pastes their own API key into a
settings field. The key is stored in `localStorage` and added as the
`x-api-key` header at request time. See `Patterns/Claude API Browser Integration`
in the Obsidian vault for the full pattern (input UI, masking, validation,
error handling, prompt-cache invalidation on key change).

Option A is the right answer for a multi-agent product. Option B is acceptable
for a personal tool used by one person.

## Other observations

- **Inline `onclick` attributes everywhere.** The current code is safe because
  no user-controlled string is interpolated near a handler attribute, but if
  client names ever land inside an `onclick`, it's an XSS risk. See
  `Patterns/onclick Attribute XSS` for the data-attribute fix.
- **`localStorage`-only persistence.** Policies live only in the browser. Cleared
  cookies / new device = lost data. Backup-export and Supabase sync are on the
  upgrade roadmap.
- **Carrier portal links open in `_blank` with `rel="noopener"`** — this is
  correct, keep it.
- **Iframes** (Insurance Toolkits) — third-party content. Token in URL.
  Rotate if leaked.
