# Google Sign-In on PolicyPilot Login Screen

**Date:** 2026-05-13
**Branch:** `feature/google-signin`

---

## Context

The PolicyPilot agent dashboard (`index.html`) currently gates access behind email/password Supabase Auth (`#auth-gate` at `index.html:1438`, handler `authSignIn()` at line 3057, lifecycle in `subscribeAuth()` at line 3273). Agents have asked for a faster way in — most have a Google Workspace identity already, and the friction of remembering yet another password slows daily login.

This change adds **"Continue with Google"** to the auth gate using Supabase's built-in OAuth provider (`sb.auth.signInWithOAuth({ provider: 'google' })`). It piggybacks entirely on the existing `onAuthStateChange` flow, so no new boot path or session model is introduced.

**Important: this is independent from the existing Google OAuth on the Calendar tab** (`gcalConnect()` at line 8605). That uses the Google Identity Services (GIS) JS SDK directly with a user-supplied Client ID to get Calendar/Gmail API tokens — it grants resource access, not application identity. Supabase's Google sign-in uses Supabase's own OAuth proxy with a Google Cloud client configured in the Supabase dashboard, and only establishes a Supabase session. We do not consolidate the two flows in this change (separate scopes, separate threat models, and the deferred `pp_google_scopes`-in-localStorage finding from the 2026-05-13 audit is not affected either way).

Front-end-first: implement the UI to completion with Supabase's OAuth call wired in, but call out the Supabase-dashboard provider-enable step as a separate backend task — the button safely surfaces "Provider is not enabled" until that's flipped.

---

## Recommended approach

A single "Continue with Google" button rendered above the email field, shared visually between the Sign in and Sign up tabs (Google OAuth makes no distinction — first sign-in auto-creates the agent row). One handler, one CSS block, no changes to `subscribeAuth()`.

### Why this shape
- **Zero changes to the existing auth lifecycle.** Supabase JS auto-detects the `?code=...` PKCE callback on page load and emits `SIGNED_IN` through the already-wired `onAuthStateChange` (line 3274), which calls `hideGate()` + `bootDashboard()`. No new code path.
- **Account linking is automatic by email** (Supabase default). An agent who signed up with `name@gmail.com` via password and later clicks "Continue with Google" using the same Google address gets the same `auth.users.id` — so all `agent_id`-keyed Supabase rows (`policies`, `leads`, `agents.contract_level`) and all `_<uid>` localStorage namespaces stay attached.
- **One button, both tabs.** Putting the button inside `.auth-tabs`/above `.auth-msg` (i.e. outside the per-view `.auth-view` containers) means it persists across the Sign in / Sign up toggle without duplication.
- **Reset password flow unaffected.** PASSWORD_RECOVERY arrives as `#access_token=...&type=recovery` (URL fragment); Google returns `?code=...` (query string). They cannot collide.

---

## File changes

All changes are in `index.html`. No new files.

### 1. CSS — new `.auth-google` button + `.auth-or` divider
Insert immediately after the `.signout-btn` block in the AUTH GATE CSS section (~line 1308).

```css
.auth-google{width:100%;padding:10px 12px;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:10px;transition:background .14s,box-shadow .14s,border-color .14s;margin-bottom:14px}
.auth-google:hover{background:#f8f9fa;box-shadow:0 1px 3px rgba(60,64,67,.15);border-color:#c6cacd}
.auth-google:disabled{opacity:.55;cursor:not-allowed}
.auth-google svg{width:18px;height:18px;flex-shrink:0}
.auth-or{display:flex;align-items:center;gap:10px;margin:0 0 14px;color:var(--text3);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
.auth-or::before,.auth-or::after{content:"";flex:1;height:1px;background:var(--border)}
```

Then add the light-theme override inside the `#auth-gate` light-theme block (~line 1322). The Google button is intentionally white in both themes (per Google's brand guidelines), but the divider needs the light-theme border color:

```css
#auth-gate .auth-or{color:#7A92B3}
#auth-gate .auth-or::before,#auth-gate .auth-or::after{background:#D6E3F2}
```

### 2. HTML — insert button + divider above `.auth-msg`
In the `#auth-gate` markup at `index.html:1438`, between the `.auth-tabs` close and the `.auth-msg` element:

```html
<button class="auth-google" id="auth-google-btn" onclick="authSignInWithGoogle()" type="button">
  <svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
    <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
  </svg>
  Continue with Google
</button>
<div class="auth-or">or</div>
```

### 3. JS — new handler `authSignInWithGoogle()`
Insert after `authSignIn()` (ends ~line 3064), before `authSignUp()` (starts ~line 3066):

```js
async function authSignInWithGoogle() {
  const btn = document.getElementById('auth-google-btn');
  if (btn) btn.disabled = true;
  authMsg('', null);
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) {
    authMsg(error.message, 'err');
    if (btn) btn.disabled = false;
  }
}
```

### 4. Nothing else changes
- `subscribeAuth()` (line 3273): untouched. `SIGNED_IN` already triggers `hideGate()` + `bootDashboard()`.
- `claimLegacyData()` (line 3128): untouched. Runs as today on first sign-in for both providers.
- `authSignOut()` (line 3100): untouched. `sb.auth.signOut()` clears the Google-issued session identically.

---

## Backend prerequisite (separate task — not blocked by this PR)

The button will return Supabase's "Provider is not enabled" error until this is done:

1. **Google Cloud Console** → APIs & Services → Credentials → Create OAuth Client ID (Web application).
   - Authorized redirect URI: `https://cweiaibjigjwspmshcrj.supabase.co/auth/v1/callback`
   - Authorized JavaScript origins: production URL and any `localhost:<port>` used for dev.
2. **Supabase Dashboard** → Authentication → Providers → Google → enable, paste Client ID + Client Secret, save.
3. **Supabase Dashboard** → Authentication → URL Configuration → add the dashboard URL(s) to "Redirect URLs" so `redirectTo` is accepted.

This is a config change, not code, so it's not part of the file diff.

---

## Out of scope (deliberate YAGNI)

- Apple, Microsoft, or other OAuth providers (same pattern, add later if asked).
- Replacing/consolidating the existing Calendar/Gmail Google OAuth in `gcalConnect()` — separate scopes, different threat surface, and the audit-deferred `pp_google_scopes` localStorage finding lives there.
- Account-linking UI (showing "you already have a password — link your Google?"). Supabase auto-links by verified email; explicit UI is a future enhancement.
- A "Continue with Google" button on `client.html`. The dashboard is sales-side; client-side Google flows would be a separate design.
- Migrating the existing audit-deferred Google access token in localStorage. Untouched.

---

## Critical files

| Path | Why |
|---|---|
| `index.html:1278-1323` | Auth gate CSS (default + light-theme overrides) — new `.auth-google` and `.auth-or` rules go here. |
| `index.html:1438-1469` | `#auth-gate` markup — insert button + divider above `.auth-msg`. |
| `index.html:3057-3064` | `authSignIn()` — new `authSignInWithGoogle()` handler goes immediately after. |
| `index.html:3273-3292` | `subscribeAuth()` — read-only; verifies the SIGNED_IN path the redirect lands on. |

---

## Verification

Front-end-only checks (do these first; backend not required):

1. **Visual:** open `index.html` locally → auth gate renders. Button appears above the "or" divider, above `.auth-msg`, in both Sign in and Sign up views. Light theme: white card, blue-grey divider lines. Dark theme: same white Google button (intentional brand consistency), divider lines use `var(--border)`.
2. **Hover/disabled:** hover dims background to `#f8f9fa`; clicking disables the button until the redirect fires (or until error returns).
3. **Provider-not-enabled error path:** click "Continue with Google" before the dashboard is configured → expect `.auth-msg.err` to display Supabase's error string ("Unsupported provider: provider is not enabled" or similar). Button re-enables.
4. **Reset-password regression:** trigger a password reset email, click the link, confirm `#access_token=...&type=recovery` still routes to `view-reset` (PASSWORD_RECOVERY branch in `subscribeAuth`).

Full-flow checks (after backend prerequisite completes):

5. **Fresh Google sign-in:** click button → Google consent → returns to dashboard with gate hidden, sidebar visible, `currentAgent` populated, `bootDashboard()` ran (Summary tab loads with widgets).
6. **Account linking:** sign up via password as `tester@gmail.com`, sign out, sign in via Google as the same address → confirm same `currentAgent.id` (check `policies`/`leads` from prior session are present).
7. **Sign-out:** `authSignOut()` clears the Google session same as the password session — re-loading shows the gate.
8. **Existing Calendar/Gmail OAuth still works:** open Calendar tab, click "Sign In & Sync Calendar" → independent flow still completes (separate Client ID, separate token in `pp_google_scopes`).
