# Security Notes

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

## CRITICAL — AI Health Parser cannot work as shipped

`index.html` line 987 calls Anthropic's Messages API directly from the browser:

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
