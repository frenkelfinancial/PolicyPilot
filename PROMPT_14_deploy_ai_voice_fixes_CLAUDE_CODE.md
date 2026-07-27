# PROMPT 14 — Deploy the AI dialer silent-call fix + voice selection (fully autonomous)

You are deploying changes that are ALREADY WRITTEN in this repo. Do NOT redesign,
rewrite, or "improve" the logic — your job is verify → apply → deploy → push →
print the human test checklist. Work from the repo root.

## Context (what changed and why)

First live Phase 1 test: the phone rang and connected but the AI never spoke.
Root cause class: when the webhook's `ai_assistant_start` Telnyx action fails
(e.g. a `TELNYX_AI_ASSISTANT_ID` that doesn't match Mission Control), the old
code only wrote a `console.error` — the lead heard dead air and nothing surfaced
in the UI. These already-applied edits fix visibility and add per-agent AI voice
selection:

- `supabase/functions/ai-call-start/index.ts` — preflights
  `GET /v2/ai/assistants/{TELNYX_AI_ASSISTANT_ID}` before dialing and fails fast
  with error code `assistant_not_found`; selects `agents.ai_voice`, passes it in
  `client_state.vars.voice`, records it on `ai_calls.voice`.
- `supabase/functions/ai-call-webhook/index.ts` — sends the agent's voice as the
  top-level `voice` override on `ai_assistant_start`; on a non-2xx response it
  writes `ai_calls.error_detail` AND hangs the call up instead of leaving dead
  air; same treatment when the assistant secret is missing.
- `app.html` — AI Dialer Test rig: new "1b · AI voice" picker (`AI_VOICES`
  const, saved to `agents.ai_voice`), red "Error detail" block in live status,
  `assistant_not_found` added to the gate-message map.
- `supabase/migrations/20260727_ai_dialer_voice_and_errors.sql` — NEW, idempotent:
  adds `ai_calls.error_detail`, `ai_calls.voice`, `agents.ai_voice`.

## Step 0 — Sanity check (STOP if any fails)

Confirm all four markers exist; if any is missing, STOP and report — do not
recreate the code yourself:

1. `grep -c "assistant_not_found" supabase/functions/ai-call-start/index.ts` ≥ 1
2. `grep -c "startBody.voice" supabase/functions/ai-call-webhook/index.ts` ≥ 1
3. `grep -c "aiTest-voice" app.html` ≥ 1
4. `test -f supabase/migrations/20260727_ai_dialer_voice_and_errors.sql`

Also `git status` — if files OTHER than these four (plus this prompt file) have
uncommitted changes, leave them untouched and only stage the listed files.

## Step 1 — Apply the migration to the remote Supabase project

The SQL is idempotent (add column if not exists only). Try in this order and
stop at the first success:

1. `psql` with a connection string from `SUPABASE_DB_URL` in the environment or
   `.env.local`: `psql "$SUPABASE_DB_URL" -f supabase/migrations/20260727_ai_dialer_voice_and_errors.sql`
2. `supabase db push` against the linked project — BUT only if it cleanly picks
   up just the new migration. If it wants to repair history or replay older
   migrations, ABORT the push (answer no).
3. If neither works non-interactively: print the full SQL in a fenced block,
   tell the user to paste it into the Supabase SQL Editor, and PAUSE here until
   they confirm — then continue.

Verify afterwards (via the same connection, if you have one):
`select column_name from information_schema.columns where table_name='ai_calls' and column_name in ('error_detail','voice');` → 2 rows,
and `agents.ai_voice` exists.

## Step 2 — Deploy the two edge functions

```
supabase functions deploy ai-call-start ai-call-webhook
```

Run from the repo root so `supabase/config.toml` is honored — it pins
`[functions.ai-call-webhook] verify_jwt = false`. This flag is load-bearing:
if it silently resets to true, Telnyx gets 401s and the dialer goes dark (see
the 2026-07-09 incident note at the top of config.toml). After deploying,
confirm the deploy output / `supabase functions list` shows ai-call-webhook
with JWT verification OFF and ai-call-start with it ON.

## Step 3 — Verify secrets exist (presence only, values are hidden)

`supabase secrets list` must include: `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`,
`TELNYX_AI_ASSISTANT_ID`, `TELNYX_PUBLIC_KEY`. If `TELNYX_AI_ASSISTANT_ID` is
missing, STOP and say so. You cannot validate its value from here — that is
exactly what the new preflight does at call time, so a mismatch will now show
up as an instant `assistant_not_found` error in the test rig instead of a
silent call.

## Step 4 — Run the existing affected tests

```
deno test supabase/functions/_shared/ai-call-billing.test.ts
```

(Billing logic was not touched; this is a regression guard. If deno isn't
installed, note it and continue.)

## Step 5 — Commit and push

Single commit containing ONLY: `app.html`, the two function files, the new
migration, and this prompt file. Message:

```
AI dialer: surface ai_assistant_start failures + per-agent voice selection

- ai-call-start: preflight assistant id (assistant_not_found), read agents.ai_voice
- ai-call-webhook: voice override on ai_assistant_start; write ai_calls.error_detail + hang up on failure (no more dead-air calls)
- app.html test rig: AI voice picker (1b), error detail display
- migration 20260727: ai_calls.error_detail/voice, agents.ai_voice
```

Push to the default branch (GitHub Pages serves app.html from it). Do NOT touch
marketing pages, Stripe code, or the human power-dialer paths.

## Step 6 — STOP and print this manual checklist for the human

1. Hard-refresh the app (Ctrl+Shift+R) → AI Dialer Test tab.
2. In "1b · AI voice" pick a voice (e.g. Matthew — male, or Joanna — female).
   Expect the "AI voice saved" toast. If it errors with an RLS/permission
   message, report back — the agents-table update policy needs a look.
3. Start AI call to your consented cell. ANSWER AND STAY ON THE LINE ~10
   SECONDS — premium AMD needs a few seconds of silence after pickup before
   the assistant attaches. Expect the compliance greeting in your chosen voice.
4. Failure modes, now all visible:
   - Instant `assistant_not_found` in the response box → fix the
     TELNYX_AI_ASSISTANT_ID secret (must be the `assistant-…` id from Mission
     Control → AI → AI Assistants), redeploy secrets, retry.
   - Red "Error detail" in live status (`ai_assistant_start 4xx: …`) → paste
     the exact text back into chat; also test the assistant with the built-in
     test call in Mission Control (if it's silent there too, the assistant's
     own voice/model config is broken — e.g. an ElevenLabs voice with no API
     key integration).
   - `no_answer` with `Answered at —` again → AMD never classified you as
     human; retry and stay silent for 2–3 s after saying "hello".
5. Say "remove me" on a follow-up call → outcome `dnc_request`, suppression row
   written; then "Reset DNC test" and confirm re-dial works.
6. Wallet receipts: one `ai_call` debit at $0.075/min per answered call.
