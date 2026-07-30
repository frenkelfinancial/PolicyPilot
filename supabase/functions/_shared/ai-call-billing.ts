// ============================================================
// ai-call-billing.ts
// Pure helpers for closing out an AI Sales Agent call and debiting the
// wallet exactly once. Kept dependency-free (no supabase / no Deno globals)
// so it runs under BOTH `node --test` (ai-call-billing.test.ts) and the
// Deno edge runtime (ai-call-webhook). The actual tier math lives in
// ai-minute-billing.ts (mirror of the SQL RPC); this module owns the
// whole-minute rounding and the idempotency contract.
// ============================================================

/**
 * Whole billable minutes for a finished AI call.
 *
 * Answered calls round UP with a 1-minute minimum (matches the human
 * dialer's reportMinutesToWallet and the PROMPT's "ceil, min 1"):
 *   1s..60s   -> 1 min
 *   61s..120s -> 2 min
 *
 * A call that never produced talk time (durationSecs <= 0 — an AMD-detected
 * voicemail we hang up on, a no-answer) bills 0. This is deliberate and
 * house-consistent: "never charge for undelivered" is the core wallet
 * promise, and screening out voicemails is a headline benefit of this
 * feature, not something the agent should pay a minimum minute for. The
 * "min 1" floor only applies once a call has actually connected.
 */
export function computeBilledMinutes(durationSecs: number): number {
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) return 0;
  return Math.max(1, Math.ceil(durationSecs / 60));
}

/**
 * Idempotency contract for the AI-call debit. Given a way to check whether
 * this call was already debited and a way to perform the debit, runs the
 * debit AT MOST once. Returns whether a debit happened.
 *
 * The webhook wires `hasExistingDebit` to a wallet_ledger lookup by ref_id
 * (call_control_id) for category 'ai_call' and `debit` to
 * wallet_debit_ai_minutes. A replayed hangup event finds the prior row and
 * skips — so the same call can't be charged twice. (A DB-level partial
 * unique index on wallet_ledger(ref_id) where category='ai_call' is the
 * race-safe backstop for a concurrent double-fire; see the migration.)
 */
export async function debitAiCallOnce(deps: {
  hasExistingDebit: () => Promise<boolean> | boolean;
  debit: () => Promise<void> | void;
}): Promise<{ debited: boolean }> {
  if (await deps.hasExistingDebit()) return { debited: false };
  await deps.debit();
  return { debited: true };
}

/**
 * Assistant outcome tags the webhook understands. Must stay in step with the
 * `ai_calls_outcome_check` constraint (20260753) — a tag missing there is a
 * 23514 on the finalize UPDATE, i.e. a call that ends with no outcome at all.
 *
 * `completed` is the honest last resort for a call that reached a person and
 * that nothing classified. It is NOT `error`: error means we broke, and it
 * also suppresses the wallet debit (see ai-call-webhook's finalize block), so
 * using it for "the classifier came up empty" both libels the call and gives
 * away the minute. See _shared/ai-call-outcome.ts.
 */
export const AI_CALL_OUTCOMES = [
  "voicemail",
  "no_answer",
  "busy",
  "not_interested",
  "qualified",
  "dnc_request",
  "callback_requested",
  "appointment_booked",
  "transferred",
  "completed",
  "error",
  "in_progress",
] as const;

export type AiCallOutcome = (typeof AI_CALL_OUTCOMES)[number];

/**
 * Coerce an assistant/webhook-supplied outcome string to a valid
 * ai_calls.outcome value, defaulting to `fallback` for anything unknown.
 * Trims + lowercases and accepts a few natural-language synonyms the
 * assistant script might emit.
 */
export function normalizeOutcome(
  raw: unknown,
  fallback: AiCallOutcome = "error",
): AiCallOutcome {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((AI_CALL_OUTCOMES as readonly string[]).includes(v)) return v as AiCallOutcome;
  // A few synonyms the assistant/Telnyx may use.
  const synonyms: Record<string, AiCallOutcome> = {
    machine: "voicemail",
    answering_machine: "voicemail",
    voicemail_detected: "voicemail",
    noanswer: "no_answer",
    no_answer_timeout: "no_answer",
    declined: "not_interested",
    not_qualified: "not_interested",
    interested: "qualified",
    // 'transfer' used to map to 'qualified' — there was no transfer outcome to
    // map it to. There is now, and a call the agent actually took should not
    // read the same as one that never left the assistant.
    transfer: "transferred",
    transferred_to_agent: "transferred",
    warm_transfer: "transferred",
    appointment: "appointment_booked",
    appointment_set: "appointment_booked",
    booked: "appointment_booked",
    callback: "callback_requested",
    call_back: "callback_requested",
    callback_scheduled: "callback_requested",
    dnc: "dnc_request",
    do_not_call: "dnc_request",
    remove_me: "dnc_request",
    stop: "dnc_request",
  };
  return synonyms[v] ?? fallback;
}
