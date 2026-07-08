# Gmail OAuth — Step 1 setup & deploy checklist

Server-side authorization-code flow for `gmail.readonly`. Refresh token is
AES-256-GCM encrypted and stored server-side; the browser never sees a secret.

## 1. Google Cloud console (OAuth test mode)
1. APIs & Services → **Enable** the **Gmail API**.
2. OAuth consent screen → **External**, publishing status **Testing**.
   - Add your Gmail as a **Test user** (up to 100 allowed).
   - Scope: add **`.../auth/gmail.readonly`** (restricted — that's expected in test mode).
   - App homepage / privacy policy URLs: your producerstackcrm.com pages (needed later for verification; fine to fill now).
3. Credentials → **Create OAuth client ID** → **Web application**.
   - **Authorized redirect URI (must match byte-for-byte):**
     ```
     https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/gmail-oauth-callback
     ```
   - Copy the **Client ID** and **Client secret**.

> This is a *separate* OAuth client from the Calendar GIS integration. Keeping
> them separate avoids scope-review entanglement.

## 2. Supabase edge-function secrets
```bash
# 32-byte key for encrypting refresh tokens + sealing OAuth state
openssl rand -base64 32          # copy the output into TOKEN_ENC_KEY

npx supabase secrets set \
  GOOGLE_CLIENT_ID="...apps.googleusercontent.com" \
  GOOGLE_CLIENT_SECRET="GOCSPX-..." \
  TOKEN_ENC_KEY="<openssl output>" \
  APP_URL="https://producerstackcrm.com"
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 3. Database
Run `supabase/migrations/20260708_gmail_accounts.sql` in the SQL editor
(schema is applied manually in this project — do **not** `db push`).

## 4. Deploy the functions
```bash
npx supabase functions deploy gmail-oauth-start
npx supabase functions deploy gmail-oauth-callback --no-verify-jwt   # callback has NO Supabase JWT
npx supabase functions deploy gmail-disconnect
```
The callback's `config.toml` already sets `verify_jwt = false`; the
`--no-verify-jwt` flag makes it explicit. If the CLI ever ignores the toml,
also toggle it in the Dashboard (Edge Functions → gmail-oauth-callback →
Settings → Enforce JWT verification → OFF).

## 5. Test
1. Sign into app.html → **Settings → Integrations → Connect Gmail**.
2. Google consent screen (you'll see the "unverified app" test-mode warning) → **Allow**.
3. You're redirected back to `app.html?gmail=connected`, the card shows
   **Connected as <you@gmail.com>**, and a row exists in `gmail_accounts`
   (with `gmail_account_secrets.refresh_token_enc` populated — and *not*
   readable via the anon/authenticated API).
4. **Disconnect** revokes at Google and deletes both rows.

### Error reasons you might see on the return URL (`?gmail=error&reason=...`)
`access_denied` (you cancelled) · `no_refresh_token` (didn't click Allow / Google
withheld it) · `expired_state` (took >10 min) · `token_exchange_failed`
(client id/secret or redirect-URI mismatch) · `db_error`.

## Notes for later phases (no rework needed)
- The token helper (decrypt refresh → mint access token, mark `reauth_required`
  on `invalid_grant`) lands in Phase 2's `gmail-sync`; the `status` column and
  reconnect banner are already wired.
- Going to production = publish the consent screen + Google review + annual CASA
  (build plan §3). No code changes — scope and redirect URI stay the same.
- **Mobile (Capacitor):** this uses a full-page web redirect, which works in the
  browser. The in-app iOS/Android flow may need `@capacitor/browser` + a deep
  link back; deferred until the web pilot is validated.
