# PROMPT 11 — Deploy phone-number replace/buy fixes + orphan audit

Paste everything below this line into Claude Code from the repo root.

---

Two Telnyx edge functions and app.html were just fixed locally (changes are already in the working tree — do NOT rewrite them, just verify and deploy):

1. `supabase/functions/telnyx-buy-number/index.ts` and `supabase/functions/telnyx-replace-number/index.ts` now re-search the exact number via `available_phone_numbers?filter[phone_number][starts_with]` immediately before `number_orders` (fixes Telnyx error 10027 "Did you first search for the number(s)?").
2. `telnyx-replace-number` now releases the old number with 3 retries + backoff, treats not-found as already released, and returns `old_released: boolean`. `app.html` shows an amber warning toast when `old_released === false`.

## Tasks

1. **Verify the edits are present** (don't assume):
   - Both functions contain `telnyxConfirmAvailable` and call it before the `number_orders` fetch, returning a 409 with a "no longer available" message when the search comes back empty.
   - `telnyx-replace-number` contains `telnyxReleaseWithRetry` and returns `old_released` in the success response.
   - `app.html` handles `data.old_released === false` in the replace success path.
   If anything is missing, stop and report — do not re-implement.

2. **Deploy both functions:**
   ```
   supabase functions deploy telnyx-buy-number telnyx-replace-number
   ```
   If the CLI isn't linked/logged in, tell me the exact commands to run rather than guessing project refs.

3. **Rebuild the www copy** (it's a build artifact of root app.html):
   ```
   npm run prebuild
   ```
   Then run `npm run check` and confirm it passes.

4. **Orphaned number audit** — old numbers may still be billing on Telnyx because (a) pre-fix replaces failed before the release step, or (b) past release failures were silently swallowed. Write and run a one-off script (Deno or Node, using `TELNYX_API_KEY` from env — ask me for it, never hardcode or commit it) that:
   - Lists all numbers on the Telnyx account (`GET /v2/phone_numbers`, paginate).
   - Lists all `e164` values in the Supabase `phone_numbers` table (use the service role key from env).
   - Prints numbers that exist on Telnyx but NOT in the DB — these are orphans costing money.
   - Do NOT auto-delete anything. Print the list with Telnyx IDs and let me confirm which to release.

5. When done, summarize: deploy status, check result, and the orphan list (or "none found").

## Guardrails
- Never print or commit API keys.
- Don't touch `data/carrier_bonuses.json`, the `CARRIER_BONUSES` const, or anything under `docs/` — unrelated to this task.
- If a deploy fails, show me the full error instead of retrying blindly.
