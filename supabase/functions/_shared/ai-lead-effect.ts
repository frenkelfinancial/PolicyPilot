// ============================================================
// ai-lead-effect.ts
// What an AI call outcome does to the LEAD.
//
// The question this module answers is the one the owner asked out loud —
// "does the AI update the status?" — and until now the honest answer was
// "partly, in two places, and nowhere written down". A dnc_request wrote a
// suppression row and flipped `leads.dnc`; an appointment wrote an
// ai_appointments row; everything else did nothing at all and no screen said
// so. This is that mapping, in one table, applied in one place.
//
// ---- The two rules that shape it -------------------------------------------
//
// 1. A MISSED CALL IS NOT A PIPELINE EVENT. `no_answer` and `voicemail` leave
//    the status exactly where it was. A six-step campaign dialling somebody
//    five times would otherwise walk that lead back to "No Answer" on every
//    attempt, overwriting whatever a human had decided about them, and the
//    leads board — the thing the agent actually works from — would become a
//    log of the robot's afternoon.
//
// 2. SOLD IS HUMAN, ALWAYS. Nothing here writes `sold`, and nothing here
//    writes over it either. A sale is a policy, a signature and money; the AI
//    has no way to know one happened and no business asserting it.
//
// The rest is the ordering guard: an outcome that arrives after a person has
// already made up their mind about the lead loses. See aiStatusVerdict().
//
// PURE HALF MIRRORED in the `// <leadeffect-core>` block of app.html, because
// the leads list renders the same disposition chips and the same labels.
// test/campaign-mission-control.test.mjs runs both over a shared table.
// ============================================================

/**
 * The app's real lead-status vocabulary — `STATUS_CONFIG` in app.html, stored
 * verbatim in `leads.data.status` for every lead in production.
 *
 * Listed here so the mapping below can be checked against it rather than
 * against a value somebody hoped existed. NOTHING IN THIS MODULE MAY INVENT A
 * STATUS: a new value would land in a book that humans filter, sort and count
 * on, and no existing screen would know what to call it.
 */
export const LEAD_STATUSES = [
  "new", "called", "no_answer", "not_interested",
  "sold", "appointment", "social_obj", "banking_obj",
] as const;

/** Set by a human hand, and off limits to everything in here. */
export const LEAD_STATUS_HUMAN_ONLY = ["sold"] as const;

/**
 * The keys this module writes into `leads.data`.
 *
 * `status` already existed. The other four are new, and they are the reason
 * the whole thing is safe: `status_at` + `status_source` are what let a
 * server-side write and a browser-side whole-book re-upsert be told apart —
 * by the ordering guard here, and by `leads_preserve_ai_status()` in the
 * database (20260805), which refuses a browser UPDATE that would carry a
 * stale copy of them back over the top.
 */
export const AI_LEAD_EFFECT_KEYS = [
  "status", "status_at", "status_source", "ai_disposition", "ai_disposition_at",
] as const;

/** What a status write claims about itself. */
export type LeadStatusSource = "ai" | "human";

export interface LeadEffect {
  /** The status to write, or null for "leave the pipeline alone". */
  status: string | null;
  /** Raise the lead's do-not-call flag. */
  dnc: boolean;
  /**
   * The chip on the lead row. Non-null for every outcome that says something
   * about the CONSUMER — which is every outcome except the two that say
   * something about us (`error`) or about nothing yet (`in_progress`).
   */
  disposition: string | null;
}

const NO_EFFECT: LeadEffect = { status: null, dnc: false, disposition: null };

/**
 * outcome → what it does to the lead.
 *
 * Every value of `ai_calls.outcome` appears here (the CHECK constraint's list,
 * 20260753), including the ones whose answer is "nothing" — an outcome missing
 * from this table would silently do nothing, and "nothing" has to be a written
 * decision rather than a gap.
 */
const EFFECTS: Record<string, LeadEffect> = {
  // ---- Changes the status ------------------------------------------------
  // The same value the lifecycle campaigns trigger on (`status is
  // appointment`), so the Appointment Reminder campaign fills itself off a
  // booking the AI made, with no second vocabulary in between.
  appointment_booked: { status: "appointment", dnc: false, disposition: "appointment_booked" },
  // A real status in the dropdown, and the one a human would have picked
  // after the same conversation.
  not_interested:     { status: "not_interested", dnc: false, disposition: "not_interested" },

  // ---- Changes a FLAG, never the status ----------------------------------
  // The suppression row and leads.dnc are the enforcement; the status is left
  // alone because "do not call me" is not a stage of a sales pipeline, and
  // burying it in the status column is how it stops being visible as a legal
  // instruction. The chip and the DNC flag on the row are where it shows.
  dnc_request:        { status: null, dnc: true, disposition: "dnc_request" },

  // ---- Disposition only, status untouched --------------------------------
  // A person answered and the agent took it from there. Whatever happens to
  // this lead next is a human's to record.
  transferred:        { status: null, dnc: false, disposition: "transferred" },
  qualified:          { status: null, dnc: false, disposition: "qualified" },
  callback_requested: { status: null, dnc: false, disposition: "callback_requested" },
  // A conversation that reached no conclusion is not a stage change either.
  completed:          { status: null, dnc: false, disposition: "completed" },

  // ---- Attempts. Logged, shown as "last call result", never a status ------
  no_answer:          { status: null, dnc: false, disposition: "no_answer" },
  voicemail:          { status: null, dnc: false, disposition: "voicemail" },
  busy:               { status: null, dnc: false, disposition: "busy" },

  // ---- Not about the lead at all -----------------------------------------
  // `error` means WE broke (see ai-call-outcome.ts). Hanging a disposition on
  // the consumer for our own failure would be a lie on their record.
  error:              NO_EFFECT,
  in_progress:        NO_EFFECT,
};

function norm(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** What this outcome does to the lead. An unknown outcome does nothing. */
export function leadEffectForOutcome(outcome: string | null | undefined): LeadEffect {
  const e = EFFECTS[norm(outcome)];
  return e ? { ...e } : { ...NO_EFFECT };
}

/** Every outcome this module knows, for the tests and the docs table. */
export function leadEffectOutcomes(): string[] {
  return Object.keys(EFFECTS).sort();
}

/** The chip's words. */
export function dispositionLabel(disposition: string | null | undefined): string {
  const d = norm(disposition);
  if (!d) return "";
  const map: Record<string, string> = {
    appointment_booked: "Booked an appointment",
    not_interested:     "Not interested",
    dnc_request:        "Asked not to be called",
    transferred:        "Transferred to you",
    qualified:          "Qualified",
    callback_requested: "Asked for a callback",
    completed:          "Spoke with the AI",
    no_answer:          "No answer",
    voicemail:          "Voicemail",
    busy:               "Busy",
  };
  return map[d] || "";
}

/** Short form, for a table cell where the column header already says "last call". */
export function dispositionShortLabel(disposition: string | null | undefined): string {
  const d = norm(disposition);
  if (!d) return "";
  const map: Record<string, string> = {
    appointment_booked: "Appointment booked",
    not_interested:     "Not interested",
    dnc_request:        "Do not call",
    transferred:        "Transferred",
    qualified:          "Qualified",
    callback_requested: "Callback asked",
    completed:          "Talked",
    no_answer:          "No answer",
    voicemail:          "Voicemail",
    busy:               "Busy",
  };
  return map[d] || "";
}

/**
 * How a disposition should READ — good news, bad news, or a shrug.
 *
 * One place, because the campaign table, the activity feed and the lead row
 * all colour the same fact and three colour maps drift.
 */
export function dispositionTone(disposition: string | null | undefined): "good" | "bad" | "neutral" {
  const d = norm(disposition);
  if (d === "appointment_booked" || d === "transferred" || d === "qualified") return "good";
  if (d === "dnc_request" || d === "not_interested") return "bad";
  return "neutral";
}

export interface AiStatusInput {
  /** The effect this call produced. */
  effect: LeadEffect;
  /** `leads.data.status` as it stands now. */
  leadStatus?: string | null;
  /** `leads.data.status_at` as it stands now — null on every legacy lead. */
  leadStatusAt?: string | null;
  /** `leads.data.status_source` as it stands now. */
  leadStatusSource?: string | null;
  /** When this call was placed (`ai_calls.started_at`, else `created_at`). */
  callStartedAt?: string | Date | null;
}

export interface AiStatusVerdict {
  apply: boolean;
  /** Machine-readable, and it lands in the webhook trace verbatim. */
  reason: string;
}

function asTime(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * THE ORDERING GUARD.
 *
 * An AI outcome must never overwrite a decision a person took while the call
 * was in the air. The call started at T; if the lead's status carries a stamp
 * later than T, somebody (or a later call) knew something we did not, and this
 * verdict is already out of date by the time it arrives — insights land ~8
 * seconds after the hangup, and a human can easily have clicked in between.
 *
 * A lead with NO stamp is the ordinary case today (every one of the 122 leads
 * in the production book predates the column) and it is not evidence of a
 * human write — it is evidence of nothing. Those get written.
 */
export function aiStatusVerdict(input: AiStatusInput): AiStatusVerdict {
  const effect = input.effect || NO_EFFECT;
  if (!effect.status) return { apply: false, reason: "no_status_change" };
  if (!(LEAD_STATUSES as readonly string[]).includes(effect.status)) {
    // Belt and braces against a future edit to the table above. A status the
    // app cannot render is worse than no status change at all.
    return { apply: false, reason: "unknown_status" };
  }

  const current = norm(input.leadStatus);
  if ((LEAD_STATUS_HUMAN_ONLY as readonly string[]).includes(current)) {
    return { apply: false, reason: "human_only_status" };
  }
  if (current === effect.status) return { apply: false, reason: "already_set" };

  const stampedAt = asTime(input.leadStatusAt);
  const startedAt = asTime(input.callStartedAt);
  if (stampedAt !== null && startedAt !== null && stampedAt > startedAt) {
    return {
      apply: false,
      reason: norm(input.leadStatusSource) === "ai" ? "newer_ai_verdict" : "human_set_after_call",
    };
  }

  return { apply: true, reason: "applied" };
}

// ============================================================
// The write
// ============================================================

// Structural, so this module can be unit-tested against a fake client without
// importing supabase-js — the same arrangement as voice-campaign-result.ts.
interface Db {
  from(table: string): {
    select: (cols: string, opts?: unknown) => any;
    update: (patch: Record<string, unknown>) => any;
    insert: (row: Record<string, unknown>) => any;
  };
}

export interface ApplyLeadEffectInput {
  leadId: string | null;
  agentId: string;
  outcome: string | null;
  /** `ai_calls.started_at` ?? `created_at`. The ordering guard's T. */
  callStartedAt: string | Date | null;
  /** When the call ended — what the new stamp says. */
  now: Date;
}

export interface ApplyLeadEffectResult {
  applied: boolean;
  reason: string;
  status?: string | null;
  disposition?: string | null;
  dnc?: boolean;
}

/**
 * Apply one call's outcome to its lead.
 *
 * Writes BOTH halves in one patch: the status (when the guard allows it) and
 * the disposition (always, when there is one). The disposition is not gated on
 * the ordering guard — it is a record of what happened on a call, not a claim
 * about where the lead sits, so a human changing the status afterwards does
 * not make the call's result untrue.
 *
 * NEVER THROWS. It runs inside ai-call-webhook's finalize block, after the
 * wallet has already been debited; a bookkeeping failure here must not make
 * Telnyx replay a call that is paid for and finished.
 */
export async function applyLeadEffect(
  sb: Db,
  input: ApplyLeadEffectInput,
): Promise<ApplyLeadEffectResult> {
  const effect = leadEffectForOutcome(input.outcome);
  if (!input.leadId) return { applied: false, reason: "no_lead" };
  if (!effect.disposition && !effect.status && !effect.dnc) {
    return { applied: false, reason: "no_effect" };
  }

  try {
    const { data: lead } = await sb.from("leads")
      .select("id, data, dnc")
      .eq("id", input.leadId)
      .eq("agent_id", input.agentId)
      .maybeSingle();
    if (!lead) return { applied: false, reason: "lead_missing" };

    const data = { ...((lead.data || {}) as Record<string, unknown>) };
    const nowIso = input.now.toISOString();

    const verdict = aiStatusVerdict({
      effect,
      leadStatus: typeof data.status === "string" ? data.status : null,
      leadStatusAt: typeof data.status_at === "string" ? data.status_at : null,
      leadStatusSource: typeof data.status_source === "string" ? data.status_source : null,
      callStartedAt: input.callStartedAt,
    });

    if (verdict.apply) {
      data.status = effect.status;
      data.status_at = nowIso;
      data.status_source = "ai";
    }
    if (effect.disposition) {
      data.ai_disposition = effect.disposition;
      data.ai_disposition_at = nowIso;
    }

    const patch: Record<string, unknown> = { data, updated_at: nowIso };
    // The DNC flag and the suppression row are written by applyDnc() on the
    // insights path. Setting it here too is idempotent and covers the case
    // where the outcome reached finalize by another route — an unset flag is
    // a lead the tick would keep dialling.
    if (effect.dnc && lead.dnc !== true) {
      patch.dnc = true;
      patch.dnc_at = nowIso;
    }

    await sb.from("leads").update(patch).eq("id", input.leadId).eq("agent_id", input.agentId);

    return {
      applied: true,
      reason: verdict.reason,
      status: verdict.apply ? effect.status : null,
      disposition: effect.disposition,
      dnc: !!patch.dnc,
    };
  } catch (e) {
    console.error("[ai-lead-effect]", (e as Error)?.message || e);
    return { applied: false, reason: "error" };
  }
}
