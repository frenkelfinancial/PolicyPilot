# PROMPT 10 — Redeploy dialer edge functions and prove they're healthy

Paste everything below this line into Claude Code, run from the repo root.

---

## Context

The Power Dialer fix (commit `e9ff716`) is pushed and the live `power-dialer.html` on GitHub Pages is current and syntactically valid. But the dialer is still dead in production: outcome/skip buttons do nothing and no calls ring. Prime suspect: the deployed `telnyx-dialer-skip` (and possibly other dialer functions) — the earlier file-truncation glitch happened around deploy time, so what's running in Supabase may be broken, stale, or was bundled from a truncated file. The working tree is now clean and matches origin/main; deploy ONLY from this state.

## Steps

1. Sanity-check the source you're about to deploy (refuse to proceed if any fails):
   - `git status` is clean and `git log --oneline -1` shows `897f63b` or later.
   - `tail -c 80` of `supabase/functions/telnyx-dialer-skip/index.ts` and `supabase/functions/_shared/dialer-next-lead.ts` — both must end syntactically complete (the skip file ends with `return json({ ok: true });` inside `serve`, then `});`).
2. `supabase functions list` — record each dialer function's VERSION and UPDATED_AT before deploying (include this in your summary so we can see what was stale).
3. Deploy: `supabase functions deploy telnyx-dialer-skip telnyx-dialer-create-session telnyx-dialer-end telnyx-call-status telnyx-bridge`. Watch the output for bundling errors — a syntax error here confirms the truncation theory; report it verbatim if it happens.
4. Confirm `telnyx-call-status` still has verify_jwt disabled after the deploy (config.toml governs this; an unauthenticated `curl -s -o /dev/null -w "%{http_code}" -X POST <url>/functions/v1/telnyx-call-status -d '{}'` must NOT return 401).
5. Prove the skip endpoint is alive and CORS-correct:
   - `curl -s -i -X OPTIONS <url>/functions/v1/telnyx-dialer-skip -H "Origin: https://producerstackcrm.com" -H "Access-Control-Request-Method: POST"` → expect 200 with `Access-Control-Allow-Origin: https://producerstackcrm.com`.
   - Same preflight with `Origin: https://www.producerstackcrm.com` → allowed too.
   - `curl -s -X POST <url>/functions/v1/telnyx-dialer-skip -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" -d '{}'` → expect a JSON auth/validation error (e.g. 401 unauthorized), NOT a 5xx boot failure. A 503/500 "worker boot error" means the deployed bundle is broken.
6. Also verify the two Telnyx audio secrets referenced by the dialer exist (names only — do not print values): `supabase secrets list | grep -E "RINGBACK_AUDIO_URL|TRANSITION_AUDIO_URL"`. If `RINGBACK_AUDIO_URL` is missing, say so prominently — that means the agent hears silence on their phone while leads ring, which matches the "can't hear ringing" report even when dialing works.
7. Check the recent logs for the skip function for boot/runtime errors: `supabase functions logs telnyx-dialer-skip --limit 20` (or the dashboard equivalent) and summarize anything non-trivial.

## Report back

- Before/after version+timestamp table for the 5 functions.
- Result of each curl probe.
- Whether RINGBACK_AUDIO_URL / TRANSITION_AUDIO_URL are set.
- Any log errors, verbatim.

Do NOT modify any source files in this task. Deploy and verify only.
