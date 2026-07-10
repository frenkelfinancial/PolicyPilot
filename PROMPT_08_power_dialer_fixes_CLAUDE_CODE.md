# PROMPT 08 — Fix the Power Dialer (skips every other lead, outcome clicks don't advance, Dial/Pause broken)

Paste everything below this line into Claude Code, run from the repo root.

---

## Context

You are working in the ProducerStack CRM repo. The Power Dialer is broken in production. Read these files completely before changing anything:

- `power-dialer.html` — the popup dialer UI (opened by `openPowerDialerModal()` in `app.html` via `localStorage['pd_launch']`). All frontend logic is in the inline `<script>` starting ~line 1141.
- `supabase/functions/_shared/dialer-next-lead.ts` — `dialNextLead()`, wallet hold/settle, `closeCallRowById()`.
- `supabase/functions/telnyx-dialer-skip/index.ts` — the ONLY endpoint that advances the queue.
- `supabase/functions/telnyx-call-status/index.ts` — Telnyx webhook; on natural lead hangup it clears `current_call_control_id` and does NOT advance (frontend-driven advancement).
- `supabase/functions/telnyx-dialer-create-session/index.ts`, `telnyx-dialer-end/index.ts`
- `supabase/functions/_shared/cors.ts`, `supabase/config.toml`
- `docs/audit-2026-07-09-calling-and-topup.md` — prior CORS/version-skew audit; the same failure family applies here.

Architecture recap: agent calls a host number, enters PIN, joins a Telnyx conference. `dialer_sessions` row is the single source of truth (`status`, `current_index`, `current_call_control_id`, `current_call_row_id`). The frontend renders exclusively from Supabase Realtime UPDATEs on that row. Every dial places a wallet hold (`wallet_hold`) that is settled by `reportMinutesToWallet` when the call row closes — never break that pairing.

## Reported symptoms

1. Clicking an outcome/objection (No Answer, Not Interested, Social/Banking Objection) marks the status but the dialer stays on the same lead instead of immediately dialing the next one.
2. When it does advance, it sometimes skips every other lead.
3. The ▶ Dial / Re-dial button does nothing.
4. Pause behaves wrongly.

## Root causes (verified in code — fix all of them)

### RC1 — `pdDial()` is UI-only; there is no backend re-dial at all
`power-dialer.html` ~line 1924. When a lead hangs up naturally, the webhook sets `status='dialing'`, `current_call_control_id=null`; the UI auto-pauses with "Call ended — mark outcome or re-dial". But `pdDial()` only flips `_isPaused` and restarts the *local* ringback tone — it never invokes any edge function. Worse, ~line 1931 explicitly dead-ends: if paused with no `current_call_control_id` it just prints "Call failed — mark outcome or skip this lead". The Re-dial button in `renderLeadForm()` (`btn-redial`) calls the same no-op. So once a call ends, the ONLY working action is Skip — Dial is decorative. Preview mode is equally fake: the backend has already placed the call before `pdPauseAfterAdvance()` "pauses".

### RC2 — Pause skips a lead
`pdTogglePause()` ~line 2013 "hangs up the active call by skipping it" — it calls `pdSkip()`, which invokes `telnyx-dialer-skip`, which hangs up AND dials the NEXT lead. So pressing Pause mid-call abandons the current lead and immediately rings the next one. There is no hangup-without-advance operation anywhere in the backend.

### RC3 — Double-advance race → "skips every other lead"
Three stacked problems, all client + server:
- `markOutcome()` (~line 1473) `await`s a `leads` upsert to Supabase BEFORE calling `pdSkipLead()`. During that await, `_isSkipping` is still false and every outcome button and the Skip button remain enabled. A second click (users double-click when nothing visibly happens) fires a second `telnyx-dialer-skip` → the queue advances twice → lead N+1 gets a sub-second ring and is skipped. This is the "every other lead" bug.
- `pdSkipLead()`'s 8-second safety timeout (~line 1976) re-enables the Skip button while a cold-started edge function may still be running; a retry click then double-advances the same way.
- `telnyx-dialer-skip` has zero idempotency: it advances from whatever `current_index` it reads, so any two overlapping invocations = two advances.

### RC4 — Leads with missing phone / missing `leads`-table row vanish silently
`dialNextLead()` (`_shared/dialer-next-lead.ts` ~line 365-391): if the `leads` lookup by `client_id` returns nothing, or `data.phone` is empty, or no caller ID resolves, it bumps `current_index` and `continue`s with no record whatsoever. To the agent those leads just disappear — which also reads as "it skips leads". (Note the Telnyx-reject path ~line 454 was already fixed to stall visibly; these earlier paths were not.)

### RC5 — Probable stale deployment (must verify, not assume)
The repo's `telnyx-call-status` says "frontend drives advancement — dialNextLead is ONLY called from telnyx-dialer-skip", and the dialer functions now import `_shared/cors.ts`. If the DEPLOYED versions predate either change, you get exactly the reported symptoms: an old webhook that auto-advances on hangup stacks with the frontend's outcome-click skip (= every other lead skipped), and an old apex-only-CORS `telnyx-dialer-skip` makes every skip invocation throw `FunctionsFetchError` in `pdSkip()` (= status marks but never advances; see the banner "Skip failed"). Per `docs/audit-2026-07-09-calling-and-topup.md`, only stripe/webrtc/wallet functions were redeployed that day — the `telnyx-dialer-*` family was NOT in that deploy list.

## Required changes

### Phase 1 — Server: make advancement explicit, idempotent, and complete
Modify `telnyx-dialer-skip/index.ts` (keep the same endpoint; add a `mode` field to the body — default must stay backward-compatible as `advance`):

1. Accept `{ session_id, mode: 'advance' | 'redial' | 'hangup', expected_index?: number }`.
2. **Idempotency guard**: when `expected_index` is a number and `session.current_index !== expected_index`, return `{ ok: true, noop: true, current_index }` WITHOUT advancing or hanging anything up. This makes double-clicks/retries categorically harmless.
3. `mode: 'advance'` — current behavior (pre-clear ids → close call row + settle wallet → hang up leg → `dialNextLead`).
4. `mode: 'redial'` — same teardown, but re-dial the CURRENT index: call `dialNextLead` with `current_index: session.current_index - 1` on the session object you pass in (so its `nextIndex += 1` lands back on the same lead), or add an explicit `startIndex` parameter to `dialNextLead` — pick whichever is cleaner, but do NOT duplicate the dial/hold logic.
5. `mode: 'hangup'` — teardown only (pre-clear ids, close row, settle wallet, hang up the leg), no dial. Session stays `status='dialing'` with null call ids. This is what Pause needs.
6. All modes must preserve the wallet-hold lifecycle exactly: every placed call has a hold; every closed row settles or voids it. Re-read the comments in `dialer-next-lead.ts` before touching this.

### Phase 2 — Server: stop silently swallowing undialable leads
In `dialNextLead()`, when a lead is skipped for missing lead row / missing phone / no caller ID, append a record before `continue` — insert a row into `calls` is wrong (nothing was dialed); instead update the lead's JSON: set `data.dialer_skip_reason = 'no_phone' | 'not_found' | 'no_caller_id'` and `data.status = 'no_answer'`-style is also wrong — do NOT invent statuses. Minimal correct behavior: `console.warn` with session id + index + reason, AND include a `skipped_lead_ids` notion the frontend can show — simplest robust option: write the reason into `dialer_sessions` via a new nullable `last_skip_reason text` column update (`'lead 4: no phone on file'`) that render() surfaces as a toast/banner. If you add the column, create `supabase/migrations/20260709d_dialer_skip_reason.sql`. Keep it lightweight; the goal is that no lead ever disappears without a visible trace.

### Phase 3 — Frontend (`power-dialer.html`)

1. **Instant, race-proof advancement on outcome click.** Rework `markOutcome()`:
   - First line: if `_isSkipping`, return immediately (synchronous guard).
   - For AUTO_ADVANCE statuses (`no_answer`, `not_interested`, `social_obj`, `banking_obj`): set the guard + disable ALL outcome buttons and Skip synchronously, update `outcomeMap`/log/UI, kick off the `leads` upsert WITHOUT awaiting it (`.then/.catch`, keep the console.warn), and call `pdSkipLead()` right away. The user must hear/see the next dial start immediately after clicking.
   - Non-advancing statuses (`called`, `appointment`) keep current behavior; `sold` keeps the modal.
2. **Send `expected_index`.** `pdSkip()` must pass `{ session_id, mode, expected_index: session?.current_index }`. Treat a `noop: true` response as success (the server already moved on).
3. **Disable outcome buttons while a skip is in flight.** `renderOutcomeArea()` should render buttons `disabled` when `_isSkipping`; re-render when the flag clears (both the success path and the safety timeout — and lengthen the safety timeout to 15s since cold starts exceed 8s, but ALSO make the timeout re-render outcome buttons).
4. **Make Dial real.** `pdDial()`: when `_isPaused && currentState === 'dialing' && !session.current_call_control_id && (session.current_index ?? -1) >= 0`, invoke the skip endpoint with `mode:'redial'` + `expected_index`, show "Re-dialing…" in the banner, and clear pause state. Remove the dead-end message at ~line 1931. The `btn-redial` in the lead card uses the same path automatically.
5. **Make Pause a real pause.** `pdTogglePause()` pause branch: call the endpoint with `mode:'hangup'` + `expected_index` instead of `pdSkip()`. Resume (`pdDial`) then triggers `mode:'redial'` — wait: resume after a deliberate pause should NOT auto-redial the same lead the agent already spoke to; resume should leave the session paused-idle and let the agent choose Dial (redial) or an outcome/Skip. Implement resume as: clear `_isPaused`, update buttons; if there is no live call, keep the "mark outcome, Dial to re-dial, or Skip" banner. Do not place calls implicitly on resume.
6. **`pdDeleteLead()`** currently calls `pdSkip()` directly — route it through `pdSkipLead()` so it gets the in-flight guard and expected_index (it deletes the current lead then advances; that's `mode:'advance'`).
7. Keep preview mode working with the new flow: after an advance in preview mode the auto-pause stays, and Dial (now a real redial when the auto-dialed call was intercepted… it isn't — the call is already live in preview mode) — leave preview semantics as-is except everything above; do not attempt to redesign preview in this prompt.

### Phase 4 — Deploy + verify (do not skip; RC5 may be the user's dominant symptom)
1. `deno check supabase/functions/telnyx-dialer-skip/index.ts supabase/functions/telnyx-call-status/index.ts supabase/functions/_shared/dialer-next-lead.ts`
2. `supabase functions deploy telnyx-dialer-skip telnyx-dialer-create-session telnyx-dialer-end telnyx-call-status telnyx-bridge` — config.toml already sets `verify_jwt=false` for `telnyx-call-status`; confirm the deploy output respects it (see the 2026-07-09 401 incident at the top of `supabase/config.toml`).
3. Apply the migration if Phase 2 added one: `supabase db push` (or run the SQL in the dashboard).
4. **Commit and push ALL changes to GitHub.** This is mandatory, not optional: GitHub Pages is the sole live host (see commit f2c348e), so the updated `power-dialer.html` does not ship until pushed. Stage every modified/created file (frontend, edge functions, migration, this prompt's changes), write a descriptive commit message (e.g. `Fix power dialer: idempotent skip, real redial/pause, no silent lead skips`), and `git push` to the default branch. Run `git status` afterward to confirm the working tree is clean — nothing may be left uncommitted.
5. Manual test plan (document results in the final summary):
   - Session with 4+ leads incl. one lead with no phone → verify it surfaces a visible skip reason and every other lead is dialed exactly once, in order.
   - While lead is ringing, click "No Answer" → next lead dials immediately; double-click the button rapidly → still advances exactly one lead (watch `dialer_sessions.current_index` in the DB).
   - Let a call ring out to voicemail-hangup → UI pauses → click ▶ Dial → same lead re-dials.
   - Mid-call Pause → call hangs up, queue does NOT advance; Resume → no call placed; Dial → same lead re-dials; Skip → next lead.
   - Verify wallet ledger: each dialed call has exactly one hold and one settle/void (`wallet_ledger` by ref).

## Constraints

- Do not touch the wallet/billing RPC semantics (`wallet_hold` / `wallet_settle_call` / `wallet_void`) beyond calling them in the right places.
- Do not reintroduce server-side auto-advance on `call.hangup` in `telnyx-call-status` — frontend-driven advancement is intentional.
- Use `corsHeaders()` from `_shared/cors.ts` for any touched browser-facing function; never hand-roll CORS.
- Keep `power-dialer.html` a single self-contained file; no new build steps.
- Backward compatibility: an old cached frontend calling skip with no `mode`/`expected_index` must behave exactly as today.
- When done, ALL changes must be committed and pushed to GitHub (working tree clean) — the site is not live otherwise.
