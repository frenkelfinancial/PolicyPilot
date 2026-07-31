// ============================================================
// voice-campaign-core.ts
// The voice campaign engine's decisions, with nothing that talks to a network,
// a database or a clock it was not handed.
//
// ---- What a campaign is ----------------------------------------------------
//
// A campaign WATCHES THE BOOK and calls on its own. "New Veteran lead arrives
// -> call within a minute -> no answer? again in two hours -> then tomorrow
// morning", with stop rules like "stop once they book" or "stop once they have
// actually TALKED to the assistant for fifteen seconds". Three pieces:
//
//   trigger_groups   who gets enrolled          (vcMatchesTriggerGroups)
//   steps            what happens, and when     (vcAdvanceAfterCall)
//   stop conditions  when to leave them alone   (vcEvaluateStop)
//
// ---- The two rules that matter most ----------------------------------------
//
//   1. EVERY CALL GOES THROUGH ai-call-start. Consent, DNC, suppression, quiet
//      hours, the agent's daily cap and the wallet floor are enforced in one
//      place, by the function the Test Rig calls, and this engine never
//      reimplements any of them. What it owns is what to do with a REFUSAL —
//      see vcHandleGateRejection.
//   2. EVERY GROUP MUST NAME A LEAD TYPE. A rule builder with no positive tag
//      condition is one saved click away from calling an entire book, and the
//      person it calls did not ask to be in an experiment. vcValidateTrigger-
//      Groups refuses to save one, in the browser AND on the server.
//
// ---- Purity ----------------------------------------------------------------
//
// Dependency-free apart from _shared/ai-call-meter.ts (the ramp math, so the
// caller-ID rotation and the meter can never disagree about a number's
// budget). Runs under BOTH `node --test` and the Deno edge runtime. The BROWSER
// mirror of the parts the editor needs is the `// <vcamp-core>` block in
// app.html; test/voice-campaigns.test.mjs runs a shared table of cases through
// both. Same arrangement as ai-call-meter.ts vs `// <ai-meter-core>`.
// ============================================================

import { numberRampValue } from "./ai-call-meter.ts";

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

/**
 * Concurrent AI campaign calls one agent may have in flight.
 *
 * Three, because the assistant is a fixed cost per simultaneous conversation
 * and because a warm transfer rings the agent's actual cell — four campaigns
 * all qualifying at once is four calls the agent cannot take. Shown on screen
 * as "N/3 active".
 */
export const VC_SLOT_LIMIT = 3;

/**
 * How long an `in_progress` ai_calls row still counts against a slot.
 *
 * A call whose hangup webhook never arrived would otherwise hold a slot for
 * ever and silently stop the campaign. The lead leg is dialed with a 1800s
 * limit and the assistant stops itself at 300s, so 40 minutes is far past any
 * real call and far short of "for ever".
 */
export const VC_INFLIGHT_STALE_SECS = 2400;

/** Attempts a `double_dial` step makes before the campaign moves on. */
export const VC_DOUBLE_DIAL_ATTEMPTS = 2;

/** Gap between the two halves of a double dial. */
export const VC_DOUBLE_DIAL_RETRY_SECS = 60;

/**
 * How long a claimed-but-unfinished enrollment stays claimed.
 *
 * The claim is what makes a tick that dies mid-run safe: the next tick may not
 * re-dial anyone the dead one already picked up. But a claim that never
 * expires is a lead that never gets called again, so it leases.
 */
export const VC_CLAIM_LEASE_SECS = 600;

/** Enrollments one tick will dial for one agent, so a sweep cannot run long. */
export const VC_MAX_DIALS_PER_TICK = 25;

/** Retry gap after an infrastructure failure (Telnyx 5xx, network). */
export const VC_TRANSIENT_RETRY_SECS = 300;

/**
 * Fields that count as naming a lead type / campaign tag.
 *
 * THIS LIST IS THE GUARD. A trigger group must contain at least one `is`
 * condition on one of these, so no rule can be saved that matches the whole
 * book. `source` is here because it is how leads in this app are actually
 * tagged by their origin; `status` deliberately is NOT — "status is New"
 * describes every fresh row in the book.
 */
export const VC_TAG_FIELDS = [
  "campaign_tag",
  "tags",
  "lead_type",
  "coverage_wanted",
  "source",
];

/**
 * Lead statuses that ALSO count as narrowing the audience (20260803).
 *
 * Six of the twelve shipped campaigns are LIFECYCLE campaigns — call the
 * client we just sold, remind the person whose appointment is tomorrow, chase
 * the one who did not show. Their audience is bounded by a terminal status and
 * by the trigger, not by a lead-type tag, and under the original rule they
 * could not be expressed at all.
 *
 * FOUR VALUES, and the exclusions are the point. Each of these describes
 * people who have already been through something. `status is new` still does
 * not count — it describes every fresh row in the book, which is the exact
 * reason `status` was left out of VC_TAG_FIELDS in the first place — and
 * neither do `called`, `no_answer` or `not_interested`.
 */
export const VC_LIFECYCLE_STATUSES = ["sold", "appointment", "chargeback", "lapsed"];

/** Wait units a step may use. */
export const VC_WAIT_UNITS = ["minutes", "hours", "days"];

/** Step types. */
export const VC_STEP_TYPES = ["call", "double_dial"];

/**
 * What a step's timing is measured FROM.
 *
 * `previous_step` — every hand-made step, and the engine's original and only
 * behaviour: due `wait_value`/`wait_unit` after the previous step completed.
 * `appointment` — due at the enrollment's appointment plus `offset_minutes`
 * (negative = before). The Appointment Reminder campaign is the only shipped
 * user; nothing else needs it and nothing else should grow one casually.
 */
export const VC_STEP_ANCHORS = ["previous_step", "appointment"];

/**
 * Why a campaign calls — the branch the assistant takes.
 *
 * A reminder call, a qualification call, a customer-care check-in and a
 * referral ask cannot open with the same sentence. This value picks the REASON
 * CLAUSE of the spoken greeting and a branch of the assistant's instructions.
 * Everything else about the opening line — who is speaking, on whose behalf,
 * and that it is an assistant — is identical in every branch, because that
 * part is the disclosure.
 *
 * An unrecognised value is `qualify`, which is also what NULL means.
 */
export const VC_CAMPAIGN_GOALS = [
  "qualify",
  "remind",
  "rebook",
  "care",
  "emergency_contact",
  "referral",
  "chargeback",
];

/** Enrollment statuses. */
export const VC_ENROLLMENT_STATUSES = ["active", "completed", "stopped", "paused"];

/** Milliseconds in one unit of wait. */
const UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

function asDate(v: string | Date | number | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v).trim().toLowerCase();
}

function intOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// ------------------------------------------------------------
// 1. Trigger matching
// ------------------------------------------------------------

export interface VcCondition {
  field: string;
  op: "is" | "is_not";
  value: string;
}

export interface VcGroup {
  conditions: VcCondition[];
}

/**
 * A lead, as the matcher needs to see it: the jsonb blob plus the two
 * compliance columns that live beside it.
 */
export interface VcLead {
  id?: string;
  data?: Record<string, unknown> | null;
  tcpa_consent?: boolean | null;
  dnc?: boolean | null;
}

/**
 * Accept a group written either way.
 *
 * `[[cond, cond], …]` and `[{conditions:[cond, cond]}, …]` both parse, because
 * the NEXT round seeds twelve campaigns from plain JSON and a seed format that
 * fails on a reasonable shape is a seed format that gets hand-edited.
 */
export function vcNormalizeGroups(raw: unknown): VcGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: VcGroup[] = [];
  for (const g of raw) {
    let conds: unknown[] = [];
    if (Array.isArray(g)) conds = g;
    else if (g && typeof g === "object" && Array.isArray((g as { conditions?: unknown }).conditions)) {
      conds = (g as { conditions: unknown[] }).conditions;
    } else continue;

    const conditions: VcCondition[] = [];
    for (const c of conds) {
      if (!c || typeof c !== "object") continue;
      const rec = c as Record<string, unknown>;
      const field = typeof rec.field === "string" ? rec.field.trim() : "";
      const opRaw = typeof rec.op === "string" ? rec.op.trim().toLowerCase() : "is";
      const op = opRaw === "is_not" ? "is_not" : "is";
      const value = rec.value === null || rec.value === undefined ? "" : String(rec.value).trim();
      conditions.push({ field, op: op as "is" | "is_not", value });
    }
    out.push({ conditions });
  }
  return out;
}

/**
 * What a field is worth on a lead.
 *
 * `lead_type` is VIRTUAL and resolves the same chain ai-call-start hands the
 * assistant as `lead_type` (coverage_wanted -> lead_type -> type -> source), so
 * a rule written against the words the assistant says on the call matches the
 * leads the assistant would say them to. Everything else is read straight out
 * of `leads.data`, except the two compliance columns, which are real columns.
 */
export function vcLeadFieldValue(lead: VcLead | null | undefined, field: string): unknown {
  if (!lead) return undefined;
  const f = String(field || "").trim();
  if (!f) return undefined;
  if (f === "tcpa_consent") return lead.tcpa_consent === true;
  if (f === "dnc") return lead.dnc === true;
  const d = (lead.data || {}) as Record<string, unknown>;
  if (f === "lead_type") {
    return d.coverage_wanted ?? d.lead_type ?? d.type ?? d.source ?? undefined;
  }
  return d[f];
}

/**
 * Does one condition hold?
 *
 * Case- and whitespace-insensitive, because a lead vendor writes "Veteran",
 * "veteran" and " Veteran " in the same CSV. An ARRAY field (tags) is a
 * membership test: `tags is veteran` is true when veteran is one of them, and
 * `tags is_not veteran` is its exact negation.
 *
 * `is_not` on a MISSING field is TRUE. "lead_type is not trucker" should hold
 * for a lead with no lead type — the alternative reads as "unknown means it
 * might be a trucker", which silently shrinks every exclusion rule.
 */
export function vcConditionMatches(lead: VcLead | null | undefined, cond: VcCondition): boolean {
  const want = norm(cond.value);
  const raw = vcLeadFieldValue(lead, cond.field);
  const present = Array.isArray(raw)
    ? raw.map(norm).filter(Boolean)
    : norm(raw) === ""
    ? []
    : [norm(raw)];
  const hit = want === "" ? present.length > 0 : present.includes(want);
  return cond.op === "is_not" ? !hit : hit;
}

/**
 * Groups are OR'd, conditions inside a group are AND'd.
 *
 * NO GROUPS MATCHES NOBODY, and an EMPTY GROUP matches nobody. Both are the
 * safe direction: an unfinished rule must never be read as "everyone".
 */
export function vcMatchesTriggerGroups(lead: VcLead | null | undefined, raw: unknown): boolean {
  const groups = vcNormalizeGroups(raw);
  if (!groups.length) return false;
  return groups.some((g) =>
    g.conditions.length > 0 && g.conditions.every((c) => vcConditionMatches(lead, c))
  );
}

export interface VcValidation {
  ok: boolean;
  /** One sentence for the top of the editor, or null. */
  error: string | null;
  /** Per-group message, index-aligned with the groups as written. */
  groupErrors: (string | null)[];
}

/**
 * Does this condition NARROW the audience?
 *
 * A positive condition on a lead-type / campaign-tag field, or on `status`
 * with one of the four lifecycle values. `is_not` never counts, in either
 * case — that is the whole point of the guard.
 */
export function vcIsNarrowingCondition(cond: VcCondition | null | undefined): boolean {
  if (!cond || cond.op !== "is") return false;
  const field = String(cond.field || "").trim();
  if (VC_TAG_FIELDS.includes(field)) return true;
  if (field === "status" && VC_LIFECYCLE_STATUSES.includes(norm(cond.value))) return true;
  return false;
}

/**
 * The rule that keeps a campaign from calling the whole book.
 *
 * Every group needs at least one POSITIVE (`is`) condition that NARROWS —
 * either a tag/lead-type field, or `status` set to one of the four lifecycle
 * values. `is_not` does not count and that is the whole point: "lead type is
 * not trucker" excludes a sliver and admits everyone else, which is exactly
 * the rule someone types when they mean "everyone but truckers" and exactly
 * the campaign nobody meant to build.
 */
export function vcValidateTriggerGroups(raw: unknown): VcValidation {
  const groups = vcNormalizeGroups(raw);
  const groupErrors: (string | null)[] = [];

  if (!Array.isArray(raw) || !groups.length) {
    return {
      ok: false,
      error: "Add at least one condition group — a campaign with no trigger conditions would match nobody.",
      groupErrors,
    };
  }

  let firstError: string | null = null;
  groups.forEach((g) => {
    let err: string | null = null;
    if (!g.conditions.length) {
      err = "This group has no conditions.";
    } else if (g.conditions.some((c) => !c.field)) {
      err = "Every condition needs a field.";
    } else if (g.conditions.some((c) => c.op !== "is" && c.op !== "is_not")) {
      err = 'A condition can only be "is" or "is not".';
    } else if (g.conditions.some((c) => !c.value)) {
      err = "Every condition needs a value.";
    } else if (!g.conditions.some((c) => vcIsNarrowingCondition(c))) {
      err = "Every group must narrow who gets called with an “is” condition — either a lead type " +
        `or campaign tag (${VC_TAG_FIELDS.join(", ")}), or a lifecycle status ` +
        `(status is ${VC_LIFECYCLE_STATUSES.join(", ")}) — otherwise this campaign could call your whole book.`;
    }
    groupErrors.push(err);
    if (err && !firstError) firstError = err;
  });

  return { ok: !firstError, error: firstError, groupErrors };
}

// ------------------------------------------------------------
// 2. Steps and the wait clock
// ------------------------------------------------------------

export interface VcStep {
  id?: string;
  position: number;
  step_type?: string | null;
  wait_value?: number | null;
  wait_unit?: string | null;
  drip_rate?: VcDripRate | null;
  /** "previous_step" (default) or "appointment". See VC_STEP_ANCHORS. */
  anchor?: string | null;
  /** Only read for an "appointment" anchor. Negative = before. */
  offset_minutes?: number | null;
}

export interface VcDripRate {
  per_minutes?: number | null;
  max_calls?: number | null;
}

/** Steps in the order they run. Positions may be sparse; order is what counts. */
export function vcStepsSorted(steps: VcStep[] | null | undefined): VcStep[] {
  return [...(steps || [])].sort((a, b) => intOr(a.position, 0) - intOr(b.position, 0));
}

export function vcFirstStep(steps: VcStep[] | null | undefined): VcStep | null {
  return vcStepsSorted(steps)[0] || null;
}

export function vcStepAt(steps: VcStep[] | null | undefined, position: number): VcStep | null {
  return vcStepsSorted(steps).find((s) => intOr(s.position, 0) === intOr(position, 0)) || null;
}

/** The step after `position`, or null when the campaign is out of steps. */
export function vcNextStep(steps: VcStep[] | null | undefined, position: number): VcStep | null {
  const pos = intOr(position, 0);
  return vcStepsSorted(steps).find((s) => intOr(s.position, 0) > pos) || null;
}

/** A step's wait, in milliseconds. Anything unreadable or negative is zero. */
export function vcWaitMs(value: unknown, unit: unknown): number {
  const n = intOr(value, 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const u = typeof unit === "string" ? unit.trim().toLowerCase() : "minutes";
  const per = UNIT_MS[u];
  if (!per) return 0;
  return n * per;
}

/** Is this step timed against the appointment rather than the previous step? */
export function vcStepIsAnchored(step: VcStep | null | undefined): boolean {
  return !!step && norm(step.anchor) === "appointment";
}

/**
 * The instant an appointment-anchored step wants, or null with no appointment.
 *
 * `offset_minutes` is NEGATIVE for "before", which is what every reminder is.
 * Null is a real answer and the callers treat it as one: a campaign anchored
 * to an appointment that does not exist has nothing to schedule, and guessing
 * an instant would be inventing a reminder for a meeting nobody booked.
 */
export function vcAnchoredDueAt(
  step: VcStep | null | undefined,
  appointmentAt: string | Date | null | undefined,
): Date | null {
  const at = asDate(appointmentAt ?? null);
  if (!at || !step) return null;
  return new Date(at.getTime() + intOr(step.offset_minutes, 0) * 60_000);
}

/**
 * When a step becomes due.
 *
 * For the ordinary anchor, measured from when the PREVIOUS step completed. A
 * zero wait is due immediately, which is what "call within a minute" degrades
 * to if someone types 0 — the drip rate, the slot limit and the gate chain are
 * what actually pace it.
 *
 * For an appointment anchor, measured from the appointment. With no
 * appointment in hand it falls back to `from`, which is only reachable if a
 * caller skipped vcResolveNextDue(); every caller in this codebase uses that
 * instead, precisely so "there is no appointment" is answered rather than
 * papered over.
 */
export function vcStepDueAt(
  from: string | Date,
  step: VcStep | null | undefined,
  ctx?: { appointmentAt?: string | Date | null },
): Date {
  const base = asDate(from) || new Date();
  if (!step) return base;
  if (vcStepIsAnchored(step)) {
    return vcAnchoredDueAt(step, ctx?.appointmentAt ?? null) || base;
  }
  return new Date(base.getTime() + vcWaitMs(step.wait_value, step.wait_unit));
}

export interface VcDueResolution {
  /** The step that should run next, or null when there is nothing left. */
  step: VcStep | null;
  /** ISO instant it becomes due, or null. */
  dueAt: string | null;
  /** Positions passed over because their anchored moment had already gone. */
  skipped: number[];
  reason: "ok" | "no_steps" | "all_past" | "no_appointment";
}

/**
 * The next step that can still be run, and when.
 *
 * THIS IS WHERE "NEVER FIRED LATE" LIVES. An appointment-anchored step whose
 * moment has passed is SKIPPED, not delayed: a reminder delivered after the
 * appointment is a robot telling somebody they are about to miss something
 * they have already missed, and it is worse than saying nothing. A campaign
 * enrolled ninety minutes before the appointment has missed the day-before
 * step and lands straight on the two-hours-before one; enrolled ten minutes
 * before, it has missed both and completes without dialing at all.
 *
 * Ordinary steps are never skipped — their due time is computed forward from
 * `now`, so it is always in the future by construction.
 *
 * `fromPosition` is EXCLUSIVE: pass the position that just ran, or 0/null to
 * resolve the first step at enrollment.
 */
export function vcResolveNextDue(input: {
  steps: VcStep[] | null | undefined;
  fromPosition?: number | null;
  now: Date;
  appointmentAt?: string | Date | null;
}): VcDueResolution {
  const from = intOr(input.fromPosition, 0);
  const all = vcStepsSorted(input.steps);
  const candidates = from > 0 ? all.filter((s) => intOr(s.position, 0) > from) : all;
  const skipped: number[] = [];

  for (const step of candidates) {
    if (!vcStepIsAnchored(step)) {
      return {
        step,
        dueAt: vcStepDueAt(input.now, step).toISOString(),
        skipped,
        reason: "ok",
      };
    }
    const due = vcAnchoredDueAt(step, input.appointmentAt ?? null);
    if (!due) {
      // No appointment to count down to. Nothing about waiting makes this
      // resolvable, so say so rather than scheduling a call at "now".
      return { step: null, dueAt: null, skipped, reason: "no_appointment" };
    }
    if (due.getTime() <= input.now.getTime()) {
      skipped.push(intOr(step.position, 0));
      continue;
    }
    return { step, dueAt: due.toISOString(), skipped, reason: "ok" };
  }

  return {
    step: null,
    dueAt: null,
    skipped,
    reason: skipped.length ? "all_past" : "no_steps",
  };
}

/** Plain-English wait, for the Steps tab and the Enrollments table. */
export function vcWaitLabel(step: VcStep | null | undefined): string {
  if (!step) return "immediately";
  const n = intOr(step.wait_value, 0);
  if (n <= 0) return "immediately";
  const u = typeof step.wait_unit === "string" ? step.wait_unit.toLowerCase() : "minutes";
  const unit = UNIT_MS[u] ? u : "minutes";
  return `${n} ${n === 1 ? unit.replace(/s$/, "") : unit}`;
}

/**
 * How a step is scheduled, in one phrase, for the Steps tab.
 *
 * Anchored steps read backwards from the appointment because that is how a
 * person says it — "the day before", not "-1440 minutes".
 */
export function vcStepScheduleLabel(step: VcStep | null | undefined): string {
  if (!step) return "immediately";
  if (!vcStepIsAnchored(step)) return vcWaitLabel(step);
  const mins = intOr(step.offset_minutes, 0);
  if (mins === 0) return "at the appointment";
  const abs = Math.abs(mins);
  const side = mins < 0 ? "before" : "after";
  let n: number;
  let unit: string;
  if (abs % 1440 === 0)   { n = abs / 1440; unit = "day"; }
  else if (abs % 60 === 0) { n = abs / 60;  unit = "hour"; }
  else                     { n = abs;       unit = "minute"; }
  return `${n} ${n === 1 ? unit : unit + "s"} ${side} the appointment`;
}

// ------------------------------------------------------------
// 3. What a finished call means
// ------------------------------------------------------------

export interface VcCallFacts {
  outcome?: string | null;
  answered_at?: string | Date | null;
  ended_at?: string | Date | null;
  /** ai_calls.appointment_id was set, i.e. the assistant booked. */
  appointment_booked?: boolean;
  /** The lead asked not to be called again (outcome dnc_request, or leads.dnc). */
  dnc?: boolean;
}

/**
 * Talk time, from the same two stamps the biller uses.
 *
 * NOT `duration_secs`: that column is written by the finalize block and a call
 * whose row this engine reads a moment earlier may not have it yet, while
 * answered_at/ended_at are the facts it is computed from. Never answered is
 * zero seconds of conversation, not a short one.
 */
export function vcTalkSeconds(call: VcCallFacts | null | undefined): number {
  if (!call) return 0;
  const a = asDate(call.answered_at ?? null);
  const e = asDate(call.ended_at ?? null);
  if (!a || !e) return 0;
  return Math.max(0, Math.floor((e.getTime() - a.getTime()) / 1000));
}

/** Outcomes that mean nobody had a conversation with the assistant. */
const NO_CONTACT_OUTCOMES = ["no_answer", "busy", "voicemail", "error", "failed"];

/**
 * Did this call fail to reach a person?
 *
 * Keyed on `answered_at` first, because that is the fact; the outcome list is
 * the backstop for a call Telnyx answered into a voicemail greeting.
 */
export function vcIsNoAnswer(call: VcCallFacts | null | undefined): boolean {
  if (!call) return true;
  const outcome = norm(call.outcome);
  if (NO_CONTACT_OUTCOMES.includes(outcome)) return true;
  return !asDate(call.answered_at ?? null);
}

export interface VcCampaign {
  id?: string;
  name?: string | null;
  active?: boolean | null;
  dry_run?: boolean | null;
  campaign_goal?: string | null;
  stop_on_appointment_booked?: boolean | null;
  stop_on_sold?: boolean | null;
  stop_on_answered?: boolean | null;
  stop_answer_talk_secs?: number | null;
  // The rule and the four enrollment triggers. Read by vcCampaignTag() and
  // vcAutoEnrollPhrase() — the manual door's fine print and the card copy —
  // and by nothing that decides whether a call goes out.
  trigger_groups?: unknown;
  auto_enroll_new_leads?: boolean | null;
  trigger_on_sold?: boolean | null;
  trigger_on_appointment_booked?: boolean | null;
  trigger_on_missed_appointment?: boolean | null;
}

export interface VcStopVerdict {
  stop: boolean;
  reason: string | null;
}

/**
 * Should this enrollment end?
 *
 * DNC IS UNCONDITIONAL and sits above every campaign flag. Somebody who said
 * "stop calling me" is not a campaign setting; the caller also writes them to
 * the suppression list, and this is the half that stops the queue.
 *
 * "Answered" is a TALK LENGTH, not a connect. A lead who picked up, heard the
 * disclosure and hung up inside three seconds has not been spoken to, and
 * dropping them out of the campaign for it is how a book goes quiet.
 */
export function vcEvaluateStop(input: {
  campaign: VcCampaign;
  call?: VcCallFacts | null;
  leadSold?: boolean;
  leadDnc?: boolean;
}): VcStopVerdict {
  const { campaign, call } = input;
  if (input.leadDnc === true || call?.dnc === true || norm(call?.outcome) === "dnc_request") {
    return { stop: true, reason: "dnc" };
  }
  if (campaign.stop_on_appointment_booked && call?.appointment_booked === true) {
    return { stop: true, reason: "appointment_booked" };
  }
  if (campaign.stop_on_sold && input.leadSold === true) {
    return { stop: true, reason: "sold" };
  }
  if (campaign.stop_on_answered) {
    const threshold = Math.max(0, intOr(campaign.stop_answer_talk_secs, 15));
    const talked = vcTalkSeconds(call);
    if (asDate(call?.answered_at ?? null) && talked >= threshold) {
      return { stop: true, reason: "answered" };
    }
  }
  return { stop: false, reason: null };
}

export interface VcEnrollmentState {
  status: string;
  current_step_position: number;
  step_attempts: number;
  next_action_at: string | Date | null;
  stop_reason?: string | null;
}

export interface VcAdvance {
  status: "active" | "completed" | "stopped";
  current_step_position: number;
  step_attempts: number;
  /** null when nothing more is due (completed / stopped). */
  next_action_at: string | null;
  stop_reason: string | null;
  /** Which branch fired — carried into the tick's trace. */
  decision: "stopped" | "double_dial_retry" | "next_step" | "completed";
  /** Anchored steps passed over because their moment had gone. */
  skipped?: number[];
}

/**
 * Where an enrollment goes after one of its calls finished.
 *
 * Order is the meaning: STOP first (a booked appointment ends the campaign
 * whether or not there are steps left), then the double-dial retry, then the
 * next step, then done.
 */
export function vcAdvanceAfterCall(input: {
  campaign: VcCampaign;
  steps: VcStep[];
  enrollment: VcEnrollmentState;
  call?: VcCallFacts | null;
  leadSold?: boolean;
  leadDnc?: boolean;
  now: Date;
  /** The enrollment's appointment, for appointment-anchored steps. */
  appointmentAt?: string | Date | null;
}): VcAdvance {
  const { campaign, steps, enrollment, call, now } = input;

  const stop = vcEvaluateStop({ campaign, call, leadSold: input.leadSold, leadDnc: input.leadDnc });
  if (stop.stop) {
    return {
      status: "stopped",
      current_step_position: intOr(enrollment.current_step_position, 0),
      step_attempts: intOr(enrollment.step_attempts, 0),
      next_action_at: null,
      stop_reason: stop.reason,
      decision: "stopped",
    };
  }

  const pos = intOr(enrollment.current_step_position, 0);
  const current = vcStepAt(steps, pos);
  const attempts = intOr(enrollment.step_attempts, 0);

  // A double dial is ONE step that makes two attempts a minute apart. The
  // second attempt only happens on a no-answer: somebody who picked up has
  // been reached, and dialing them again sixty seconds later is the behaviour
  // that gets a number labelled.
  if (
    current && norm(current.step_type) === "double_dial" &&
    vcIsNoAnswer(call) && attempts < VC_DOUBLE_DIAL_ATTEMPTS
  ) {
    return {
      status: "active",
      current_step_position: pos,
      step_attempts: attempts,
      next_action_at: new Date(now.getTime() + VC_DOUBLE_DIAL_RETRY_SECS * 1000).toISOString(),
      stop_reason: null,
      decision: "double_dial_retry",
    };
  }

  // vcResolveNextDue, not vcNextStep: an appointment-anchored step whose
  // moment has already gone is skipped rather than fired late, and running out
  // of steps that way completes the enrollment exactly as running out of steps
  // any other way does.
  const resolved = vcResolveNextDue({
    steps,
    fromPosition: pos,
    now,
    appointmentAt: input.appointmentAt ?? null,
  });

  if (!resolved.step || !resolved.dueAt) {
    return {
      status: "completed",
      current_step_position: pos,
      step_attempts: attempts,
      next_action_at: null,
      stop_reason: null,
      decision: "completed",
      skipped: resolved.skipped,
    };
  }

  return {
    status: "active",
    current_step_position: intOr(resolved.step.position, 0),
    step_attempts: 0,
    next_action_at: resolved.dueAt,
    stop_reason: null,
    decision: "next_step",
    skipped: resolved.skipped,
  };
}

// ------------------------------------------------------------
// 4. Enrollment gates
// ------------------------------------------------------------

export interface VcEnrollVerdict {
  ok: boolean;
  /** Machine tag; the UI turns it into the "3 skipped: no consent" line. */
  reason: string | null;
  detail: string | null;
}

/**
 * May this lead be enrolled?
 *
 * These are the SAME facts ai-call-start's gate 3 reads, checked here so a
 * campaign's Enrollments tab does not fill with rows that can never be dialed.
 * IT IS NOT THE ENFORCEMENT POINT — the gate chain is, on every single call —
 * but an un-consented lead sitting "active" in a campaign looks like a promise
 * the product cannot keep.
 */
export function vcEvaluateEnrollment(input: {
  lead: VcLead;
  suppressed?: boolean;
  activeElsewhere?: boolean;
  hasPhone?: boolean;
}): VcEnrollVerdict {
  const { lead } = input;
  if (input.hasPhone === false) {
    return { ok: false, reason: "no_phone", detail: "no phone number on file" };
  }
  if (lead.tcpa_consent !== true) {
    return { ok: false, reason: "no_consent", detail: "no consent" };
  }
  if (lead.dnc === true) {
    return { ok: false, reason: "dnc", detail: "on your do-not-call list" };
  }
  if (input.suppressed === true) {
    return { ok: false, reason: "suppressed", detail: "on the suppression list" };
  }
  // Orion's rule, kept: a lead in two voice campaigns gets two robots in one
  // afternoon, and neither campaign's stats mean anything afterwards.
  if (input.activeElsewhere === true) {
    return { ok: false, reason: "already_enrolled", detail: "already in another voice campaign" };
  }
  return { ok: true, reason: null, detail: null };
}

/** The toast line: "12 leads enrolled, 3 skipped: no consent". */
export function vcEnrollSummary(enrolled: number, skipped: Record<string, number>): string {
  const entries = Object.entries(skipped || {})
    .filter(([, n]) => intOr(n, 0) > 0)
    .sort((a, b) => intOr(b[1], 0) - intOr(a[1], 0));
  const head = `${enrolled} lead${enrolled === 1 ? "" : "s"} enrolled`;
  if (!entries.length) return head;
  const total = entries.reduce((s, [, n]) => s + intOr(n, 0), 0);
  // One reason needs no count — "3 skipped: 3 no consent" says three twice.
  const parts = entries.length === 1
    ? [SKIP_LABELS[entries[0][0]] || entries[0][0]]
    : entries.map(([reason, n]) => `${intOr(n, 0)} ${SKIP_LABELS[reason] || reason}`);
  return `${head}, ${total} skipped: ${parts.join(", ")}`;
}

const SKIP_LABELS: Record<string, string> = {
  no_consent: "no consent",
  dnc: "on DNC",
  suppressed: "suppressed",
  already_enrolled: "already in a campaign",
  no_phone: "no phone",
  appointment_too_soon: "appointment too soon to remind",
  // Added with the manual "Add to campaign" door (Prompt I). The bulk action
  // hands over an explicit list of leads, so it can fail in two ways the
  // rule-driven sweep never could: a lead this campaign has already run, and
  // an id the server has never heard of.
  already_this_campaign: "already in this campaign",
  not_found: "not synced yet",
};

// ------------------------------------------------------------
// 4b. Manual enrollment — the "Add to campaign" door
//
// WHY THIS EXISTS. Until now a lead reached a campaign only through the
// trigger rules: invisible plumbing that an agent has to understand tags to
// operate. This is the other door — select leads, press a button — and it
// sits ON TOP of the engine rather than beside it. Every hard gate is the
// same function the sweep uses (vcEvaluateEnrollment); what is new here is
// only the bookkeeping around an EXPLICIT list of leads.
//
// The planner below is the whole point of the split: `preview_enroll` and
// `enroll_leads` are the same call with a flag, so the sentence the modal
// shows before you press the button is produced by the code that then runs.
// A preview that is computed separately from the action is a preview that
// eventually lies.
// ------------------------------------------------------------

/**
 * The ONE lead field the manual door will ever write.
 *
 * `campaign_tag` is canonical and this app created it (20260803) — nothing
 * else has ever written it, so setting it cannot destroy an existing value
 * that meant something else. The other four VC_TAG_FIELDS emphatically do
 * carry real data: `coverage_wanted` holds dollar amounts and `source` holds
 * vendor names in the production book. Writing either would corrupt the book
 * to tidy up a join.
 */
export const VC_ENROLL_TAG_FIELD = "campaign_tag";

/**
 * The single `campaign_tag` value this campaign's rule names, or "".
 *
 * Used for two things: the modal's fine print ("also tags these leads Final
 * Expense") and the tag write itself. Deliberately conservative —
 *
 *   * ONLY a positive (`is`) condition on `campaign_tag` counts. A rule
 *     written as `lead_type is veteran` gets NO tag write, because
 *     `lead_type` is virtual and resolves through `coverage_wanted` first:
 *     "make the lead match" would mean writing a coverage amount of
 *     "veteran".
 *   * TWO DIFFERENT tag values across the groups is ambiguous, and ambiguous
 *     means no write. Picking the first would silently re-tag a book on a
 *     detail nobody was shown.
 *
 * The twelve shipped lead-type campaigns all name exactly one, as group 1.
 */
export function vcCampaignTag(campaign: VcCampaign | null | undefined): string {
  const groups = vcNormalizeGroups(campaign ? campaign.trigger_groups : null);
  let found = "";
  for (const g of groups) {
    for (const c of g.conditions) {
      if (c.op !== "is") continue;
      if (String(c.field || "").trim() !== VC_ENROLL_TAG_FIELD) continue;
      const v = norm(c.value);
      if (!v) continue;
      if (found && found !== v) return "";   // ambiguous → write nothing
      found = v;
    }
  }
  return found;
}

/**
 * "final_expense" → "Final Expense". What a person calls the tag.
 *
 * A word of three letters or fewer is upper-cased rather than capitalised,
 * because in this vocabulary they are acronyms without exception — IUL, VA,
 * WL, UL, GUL, MP, FEX. "Iul" is not a word and reads as a typo on the one
 * screen whose whole job is to be plain.
 */
export function vcTagLabel(tag: string | null | undefined): string {
  const t = String(tag == null ? "" : tag).trim().replace(/[_-]+/g, " ");
  if (!t) return "";
  return t.split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

/**
 * How this campaign fills itself, in one plain sentence.
 *
 * Part 4 of the brief: the automation already exists and is invisible, which
 * is why an agent cannot tell an auto-filling campaign from a dormant one.
 * This is HELPER COPY ONLY — it renames nothing and reads only fields the
 * tick's sweep already branches on, so it cannot drift into describing a
 * behaviour the engine does not have.
 *
 * Note `auto_enroll_new_leads` sweeps every matching lead the campaign has
 * not seen, not only ones created since — so the phrase says "leads", not
 * "new leads". Saying "new" would be a promise the engine over-delivers on.
 */
export function vcAutoEnrollPhrase(campaign: VcCampaign | null | undefined): string {
  const c: VcCampaign = campaign || {};
  const tag = vcCampaignTag(campaign);
  const who = tag ? `leads tagged ${vcTagLabel(tag)}` : "leads matching your rules";
  const parts: string[] = [];
  if (c.auto_enroll_new_leads === true) parts.push(`Auto-enrolls: ${who}`);
  if (c.trigger_on_sold === true) parts.push("Fills when a lead is marked Sold");
  if (c.trigger_on_appointment_booked === true) parts.push("Fills when an appointment is booked");
  if (c.trigger_on_missed_appointment === true) parts.push("Fills when an appointment is marked no-show");
  // No trigger at all is not a broken campaign — six of the twelve shipped
  // ones are close to it — but an agent staring at an empty Enrollments tab
  // deserves to be told which of the two doors this campaign has.
  if (!parts.length) return "Only leads you add by hand.";
  return parts.join(" · ") + ".";
}

/** What the manual door decided to do with one lead. */
export interface VcEnrollPlanItem {
  lead_id: string;
  /** "enroll" — a fresh enrollment. "move" — stop an active one elsewhere first. */
  action: "enroll" | "move";
  /** The enrollment being stopped, on a move. */
  from_enrollment_id: string | null;
  current_step_position: number;
  next_action_at: string;
  appointment_id: string | null;
  /** The tag this enrollment implies, or "" — same value for every item. */
  tag: string;
}

export interface VcEnrollPlan {
  items: VcEnrollPlanItem[];
  /** reason → count. Every id handed in lands in items or in here, never both. */
  skipped: Record<string, number>;
  /** Of `items`, how many are moves. */
  moves: number;
  /** Leads blocked ONLY by missing consent — the "Record consent first" link. */
  no_consent_lead_ids: string[];
  tag: string;
  /** Leads that would be tagged: enrollable ones that do not already carry it. */
  tag_lead_ids: string[];
  truncated: number;
}

/**
 * Decide what "Add these leads to this campaign" means, for one press.
 *
 * PURE. Every fact it needs is handed in, which is what lets the preview and
 * the write be the same call — and lets the whole matrix be unit-tested
 * without a database.
 *
 * ORDER MATTERS and is not arbitrary:
 *   1. not_found       — an id the caller does not own. Reported, never ignored.
 *   2. already in THIS campaign — the engine never re-runs a lead through a
 *      campaign it has already seen, in any status. Saying so is kinder than
 *      an enrollment that silently does not appear.
 *   3. the shared gate  — consent, DNC, suppression, phone. vcEvaluateEnrollment,
 *      with `activeElsewhere` withheld so that conflict is decided here.
 *   4. active elsewhere — SKIP (default) or MOVE, the agent's choice.
 *   5. no reachable step — an appointment-anchored campaign whose moment has gone.
 *
 * Consent is checked BEFORE the already-in-a-campaign conflict on purpose: a
 * lead with no consent cannot be moved anywhere, and telling the agent "2 are
 * already in another campaign" about a lead that could never be called either
 * way sends them to fix the wrong thing.
 */
export function vcPlanManualEnrollment(input: {
  lead_ids: string[];
  leads: VcLead[];
  steps: VcStep[];
  now: Date;
  /** lead_id → true for any enrollment this campaign has ever had. */
  seenInThisCampaign: Set<string>;
  /** lead_id → the ACTIVE enrollment elsewhere, if any. */
  activeElsewhere: Map<string, { id: string; campaign_id: string }>;
  /** lead_id → true when the lead's phone is on a suppression list. */
  suppressed: Set<string>;
  /** lead_id → true when the lead has a usable phone number. */
  hasPhone: Set<string>;
  /** lead_id → the soonest scheduled future appointment, for anchored campaigns. */
  appointments: Map<string, { id: string; starts_at: string }>;
  onConflict: "skip" | "move";
  campaign: VcCampaign | null | undefined;
  limit: number;
}): VcEnrollPlan {
  const byId = new Map<string, VcLead>();
  for (const l of input.leads || []) if (l && l.id) byId.set(String(l.id), l);

  const tag = vcCampaignTag(input.campaign);
  const items: VcEnrollPlanItem[] = [];
  const skipped: Record<string, number> = {};
  const noConsent: string[] = [];
  const tagLeads: string[] = [];
  let truncated = 0;
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] || 0) + 1; };

  // The same lead offered twice is one lead. Deduped here rather than at the
  // edge so the counts add up to the number of DISTINCT leads, which is what
  // the sentence claims.
  const ids: string[] = [];
  const seenId = new Set<string>();
  for (const raw of input.lead_ids || []) {
    const id = String(raw == null ? "" : raw);
    if (!id || seenId.has(id)) continue;
    seenId.add(id);
    ids.push(id);
  }

  for (const id of ids) {
    const lead = byId.get(id);
    if (!lead) { skip("not_found"); continue; }
    if (input.seenInThisCampaign.has(id)) { skip("already_this_campaign"); continue; }

    const verdict = vcEvaluateEnrollment({
      lead,
      hasPhone: input.hasPhone.has(id),
      suppressed: input.suppressed.has(id),
      // Withheld deliberately — the conflict is this function's decision to
      // make, because only here is "move them" an available answer.
      activeElsewhere: false,
    });
    if (!verdict.ok) {
      const reason = verdict.reason || "skipped";
      if (reason === "no_consent") noConsent.push(id);
      skip(reason);
      continue;
    }

    const conflict = input.activeElsewhere.get(id) || null;
    if (conflict && input.onConflict !== "move") { skip("already_enrolled"); continue; }

    if (items.length >= Math.max(0, intOr(input.limit, 0))) { truncated++; continue; }

    const appt = input.appointments.get(id) || null;
    const due = vcResolveNextDue({
      steps: input.steps,
      now: input.now,
      appointmentAt: appt ? appt.starts_at : null,
    });
    if (!due.step || !due.dueAt) { skip("appointment_too_soon"); continue; }

    items.push({
      lead_id: id,
      action: conflict ? "move" : "enroll",
      from_enrollment_id: conflict ? conflict.id : null,
      current_step_position: intOr(due.step.position, 1),
      next_action_at: due.dueAt,
      appointment_id: appt ? appt.id : null,
      tag,
    });
    // Only a lead that is actually being enrolled gets tagged, and only when
    // it does not already carry the tag. Tagging a lead the gate refused
    // would change their data for a campaign they were never added to.
    if (tag && norm(vcLeadFieldValue(lead, VC_ENROLL_TAG_FIELD)) !== tag) tagLeads.push(id);
  }

  return {
    items,
    skipped,
    moves: items.filter((i) => i.action === "move").length,
    no_consent_lead_ids: noConsent,
    tag,
    tag_lead_ids: tagLeads,
    truncated,
  };
}

/**
 * The sentence the modal shows before the button is pressed, and the toast
 * after — same function, so the promise and the receipt cannot word it
 * differently. Present tense for the preview, past for the result.
 *
 * "12 will be enrolled · 2 moved from another campaign · 3 no consent"
 */
export function vcEnrollPlanSentence(plan: VcEnrollPlan, tense: "will" | "did" = "will"): string {
  const fresh = plan.items.length - plan.moves;
  const parts: string[] = [];
  if (tense === "will") {
    parts.push(`${fresh} will be enrolled`);
    if (plan.moves) parts.push(`${plan.moves} will move from another campaign`);
  } else {
    parts.push(`${fresh} enrolled`);
    if (plan.moves) parts.push(`${plan.moves} moved from another campaign`);
  }
  const skips = Object.entries(plan.skipped || {})
    .filter(([, n]) => intOr(n, 0) > 0)
    .sort((a, b) => intOr(b[1], 0) - intOr(a[1], 0));
  for (const [reason, n] of skips) {
    parts.push(`${intOr(n, 0)} ${SKIP_LABELS[reason] || String(reason).replace(/_/g, " ")}`);
  }
  if (plan.truncated) parts.push(`${plan.truncated} over the limit`);
  return parts.join(" · ");
}

// ------------------------------------------------------------
// 5. Drip rate
// ------------------------------------------------------------

/** A drip rate is only a throttle when both halves are present and positive. */
export function vcDripActive(drip: VcDripRate | null | undefined): boolean {
  if (!drip) return false;
  return intOr(drip.per_minutes, 0) > 0 && intOr(drip.max_calls, 0) > 0;
}

/** Start of the rolling window a drip rate counts over. */
export function vcDripWindowStart(now: Date, drip: VcDripRate | null | undefined): Date | null {
  if (!vcDripActive(drip)) return null;
  return new Date(now.getTime() - intOr(drip!.per_minutes, 0) * 60_000);
}

/**
 * May this step place one more call right now?
 *
 * The point of a drip is that five hundred enrolled leads do not all get dialed
 * at 9:00:00 — which is both what a carrier's spam heuristics look for and what
 * an agent watching three transfers ring at once experiences.
 *
 * Being throttled is NOT a failure: the enrollment stays due and the next tick
 * (a minute later) tries again, so a 20-per-hour step drains over the hour by
 * itself.
 */
export function vcDripAllows(input: {
  drip?: VcDripRate | null;
  placedInWindow: number;
}): { allowed: boolean; remaining: number | null } {
  if (!vcDripActive(input.drip)) return { allowed: true, remaining: null };
  const max = intOr(input.drip!.max_calls, 0);
  const used = Math.max(0, intOr(input.placedInWindow, 0));
  return { allowed: used < max, remaining: Math.max(0, max - used) };
}

// ------------------------------------------------------------
// 6. Slots
// ------------------------------------------------------------

export interface VcInflightCall {
  status?: string | null;
  created_at?: string | Date | null;
  ended_at?: string | Date | null;
}

/**
 * Campaign calls this agent has in the air.
 *
 * A row still `in_progress` whose `created_at` is older than the stale window
 * does not count — see VC_INFLIGHT_STALE_SECS. Counting it would let one lost
 * hangup webhook stop an agent's campaigns permanently, which is a far worse
 * failure than briefly running a fourth call.
 */
export function vcSlotsInUse(calls: VcInflightCall[] | null | undefined, now: Date): number {
  const floor = now.getTime() - VC_INFLIGHT_STALE_SECS * 1000;
  return (calls || []).filter((c) => {
    if (norm(c.status) !== "in_progress") return false;
    if (asDate(c.ended_at ?? null)) return false;
    const created = asDate(c.created_at ?? null);
    return !created || created.getTime() >= floor;
  }).length;
}

export function vcSlotsFree(inUse: number): number {
  return Math.max(0, VC_SLOT_LIMIT - Math.max(0, intOr(inUse, 0)));
}

/** "1/3 active". */
export function vcSlotsLabel(inUse: number): string {
  return `${Math.max(0, Math.min(VC_SLOT_LIMIT, intOr(inUse, 0)))}/${VC_SLOT_LIMIT} active`;
}

// ------------------------------------------------------------
// 7. Caller-ID rotation
// ------------------------------------------------------------

export interface VcPoolNumber {
  e164?: string | null;
  ai_first_used_at?: string | Date | null;
}

export interface VcCallerChoice {
  e164: string;
  /** The number's own recommended volume today (its ramp value). */
  recommended: number;
  /** Outbound AI calls it has already carried today. */
  used: number;
  /** recommended - used. May be negative; the recommendation never blocks. */
  headroom: number;
}

/**
 * Which of the agent's numbers should carry this call.
 *
 * THIS IS WHAT MAKES THE METER HONEST. The daily recommendation sums every
 * active number's ramp value, but until now every AI call went out on
 * `agents.signalwire_caller_id` — so a two-number agent was recommended 600
 * calls and all 600 landed on one number. Campaign calls pass an explicit
 * caller ID chosen as the number with the most room left against ITS OWN ramp,
 * using the same numberRampValue() the meter and the gate use. Two numbers
 * genuinely means two numbers' worth of pace.
 *
 * Ties break on the number itself so the choice is deterministic; because the
 * winner's usage goes up the moment it dials, a tie alternates on the next
 * call, which is the rotation.
 *
 * Everyone is over budget? It still returns the least-loaded number. The
 * recommendation is advice — refusing to dial here would turn it into the wall
 * ai-call-meter.ts exists to say it is not.
 */
export function vcPickCallerId(
  numbers: VcPoolNumber[] | null | undefined,
  usageByE164: Record<string, number> | null | undefined,
  now: Date,
  timeZone: string,
): VcCallerChoice | null {
  const usage = usageByE164 || {};
  const rows: VcCallerChoice[] = [];
  for (const n of numbers || []) {
    const e164 = typeof n?.e164 === "string" ? n.e164.trim() : "";
    if (!e164) continue;
    const recommended = numberRampValue(n?.ai_first_used_at ?? null, now, timeZone);
    const used = Math.max(0, intOr(usage[e164], 0));
    rows.push({ e164, recommended, used, headroom: recommended - used });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (b.headroom - a.headroom) || (a.e164 < b.e164 ? -1 : a.e164 > b.e164 ? 1 : 0));
  return rows[0];
}

// ------------------------------------------------------------
// 8. What to do when the gate says no
// ------------------------------------------------------------

export type VcRejectionAction = "reschedule" | "pause_campaign" | "stop_enrollment" | "retry_soon";

export interface VcRejectionPlan {
  action: VcRejectionAction;
  /** ISO instant the enrollment becomes due again, or null. */
  next_action_at: string | null;
  /** Enrollment stop reason, when action is stop_enrollment. */
  stop_reason: string | null;
  /** Campaign pause reason, when action is pause_campaign. */
  pause_reason: string | null;
  /** True when the enrollment should be left due for the very next tick. */
  leaveDue: boolean;
}

/**
 * Every way ai-call-start can refuse, and what the campaign does about it.
 *
 * The shape of this function IS the answer to "how does a scheduler behave
 * when the thing it schedules says no". Three behaviours, chosen per code:
 *
 *   RESCHEDULE  the refusal has a known expiry. A daily cap resets at a stated
 *               instant (the 429 body carries `resets_at`); quiet hours end
 *               when the lead's local window opens. Come back then — not in a
 *               minute, sixty times an hour, for the rest of the evening.
 *   PAUSE       the refusal is about the ACCOUNT, not this lead: an empty
 *               wallet, a plan downgrade, a kill switch. Every enrollment would
 *               get the same answer, so stop the campaign and put a reason on
 *               screen. Retry-hammering an empty wallet is how a log fills up
 *               and nobody notices the actual problem.
 *   STOP        the refusal is about this LEAD and will not change on its own:
 *               no consent, DNC, suppressed, no phone. Leaving them queued
 *               would re-ask the same question every tick for ever.
 */
export function vcHandleGateRejection(input: {
  code: string;
  now: Date;
  /** From a 429 body — when the agent's day rolls over. */
  resetsAt?: string | null;
  /** From vcNextAllowedInstant — when the lead's local window reopens. */
  quietUntil?: string | null;
}): VcRejectionPlan {
  const code = norm(input.code);
  const plan = (over: Partial<VcRejectionPlan>): VcRejectionPlan => ({
    action: "reschedule",
    next_action_at: null,
    stop_reason: null,
    pause_reason: null,
    leaveDue: false,
    ...over,
  });

  switch (code) {
    // Their own cap. Not an error, not a money problem — come back when the
    // agent's day rolls over. resets_at comes from the 429 body rather than
    // being re-derived here, so there is one definition of midnight.
    case "daily_cap_reached": {
      const at = asDate(input.resetsAt ?? null) ||
        new Date(input.now.getTime() + 60 * 60 * 1000);
      return plan({ action: "reschedule", next_action_at: at.toISOString() });
    }

    // The lead's local calling window is shut. Come back when it opens.
    case "quiet_hours": {
      const at = asDate(input.quietUntil ?? null) ||
        new Date(input.now.getTime() + 30 * 60 * 1000);
      return plan({ action: "reschedule", next_action_at: at.toISOString() });
    }

    // Account-level. Pause the campaign and SAY SO on the campaign card.
    case "insufficient_balance":
      return plan({
        action: "pause_campaign",
        pause_reason: "Paused: your wallet is below the AI call minimum. Top up to resume.",
        leaveDue: true,
      });
    case "ai_disabled":
      return plan({
        action: "pause_campaign",
        pause_reason: "Paused: the AI Sales Agent dialer is turned off for your account.",
        leaveDue: true,
      });
    case "upgrade_required":
      return plan({
        action: "pause_campaign",
        pause_reason: "Paused: the AI Sales Agent needs the Pro Producer or Team Leader plan.",
        leaveDue: true,
      });
    case "no_caller_id":
      return plan({
        action: "pause_campaign",
        pause_reason: "Paused: no active phone number to call from. Buy one in the Phone Book.",
        leaveDue: true,
      });

    // About this lead, and permanent until something else changes it.
    case "not_callable":
      return plan({ action: "stop_enrollment", stop_reason: "not_callable" });
    case "missing_lead_id":
      return plan({ action: "stop_enrollment", stop_reason: "lead_missing" });

    // Ours or Telnyx's. Back off, keep the enrollment.
    default:
      return plan({
        action: "retry_soon",
        next_action_at: new Date(input.now.getTime() + VC_TRANSIENT_RETRY_SECS * 1000).toISOString(),
      });
  }
}

/**
 * The next instant a call to this lead would clear quiet hours.
 *
 * Deliberately takes the predicate as an argument rather than re-deriving the
 * window: `isAllowed` is the very function ai-call-start's gate 4 calls, so
 * "when does the window open" and "is the window open" can never drift into
 * two answers. Scans forward in fifteen-minute steps for a day and a half; if
 * nothing is allowed in that span (impossible with any sane window, but a
 * misconfigured billing_config could do it) it gives up and says an hour, and
 * the gate refuses again, harmlessly.
 */
export function vcNextAllowedInstant(
  now: Date,
  isAllowed: (at: Date) => boolean,
  stepMinutes = 15,
  horizonHours = 36,
): string {
  const step = Math.max(1, stepMinutes) * 60_000;
  const limit = Math.max(1, horizonHours) * 60 * 60_000;
  for (let dt = step; dt <= limit; dt += step) {
    const at = new Date(now.getTime() + dt);
    if (isAllowed(at)) return at.toISOString();
  }
  return new Date(now.getTime() + 60 * 60_000).toISOString();
}

// ------------------------------------------------------------
// 9. Campaign context for the assistant
// ------------------------------------------------------------

/**
 * What the assistant is told about why it is calling.
 *
 * Blank stays blank, exactly as `agents.ai_agent_name` does: a campaign name
 * the agent did not write is a phrase they would have to explain to a lead.
 */
export function vcCampaignVars(campaign: VcCampaign | null | undefined, step: VcStep | null | undefined): Record<string, string> {
  const name = campaign && typeof campaign.name === "string" ? campaign.name.trim() : "";
  const pos = step ? intOr(step.position, 0) : 0;
  return {
    campaign_name: name,
    campaign_step: pos > 0 ? String(pos) : "",
    campaign_step_type: step ? (norm(step.step_type) || "call") : "",
    campaign_goal: vcCampaignGoal(campaign),
  };
}

/**
 * The campaign's goal, normalised — `qualify` for anything unrecognised.
 *
 * Unlike `campaign_name`, blank does NOT stay blank here: an unset goal is a
 * hand-made campaign, and a hand-made campaign is a qualification call. The
 * name is a phrase the agent wrote and the assistant might repeat; the goal is
 * an internal switch nobody hears, so defaulting it invents nothing.
 */
export function vcCampaignGoal(campaign: VcCampaign | null | undefined): string {
  const raw = norm((campaign as { campaign_goal?: unknown } | null | undefined)?.campaign_goal);
  return VC_CAMPAIGN_GOALS.includes(raw) ? raw : "qualify";
}

// ------------------------------------------------------------
// 10. Stats
// ------------------------------------------------------------

export interface VcCampaignStats {
  enrolled: number;
  active: number;
  completed: number;
  stopped: number;
  calls: number;
  answers: number;
  appointments: number;
}

/** Roll enrollment rows into the numbers on the campaign card. */
export function vcCampaignStats(
  enrollments: Array<{ status?: string | null; calls_placed?: number | null; answers?: number | null; appointments?: number | null }> | null | undefined,
): VcCampaignStats {
  const out: VcCampaignStats = {
    enrolled: 0, active: 0, completed: 0, stopped: 0, calls: 0, answers: 0, appointments: 0,
  };
  for (const e of enrollments || []) {
    out.enrolled++;
    const st = norm(e.status);
    if (st === "active") out.active++;
    else if (st === "completed") out.completed++;
    else if (st === "stopped") out.stopped++;
    out.calls += Math.max(0, intOr(e.calls_placed, 0));
    out.answers += Math.max(0, intOr(e.answers, 0));
    out.appointments += Math.max(0, intOr(e.appointments, 0));
  }
  return out;
}

/** Human label for `voice_campaign_enrollments.stop_reason`. */
export function vcStopReasonLabel(reason: string | null | undefined): string {
  const r = norm(reason);
  if (!r) return "";
  const map: Record<string, string> = {
    dnc: "Asked not to be called",
    appointment_booked: "Appointment booked",
    sold: "Sold",
    answered: "Answered the call",
    not_callable: "Not callable",
    lead_missing: "Lead removed",
    manual: "Unenrolled by hand",
    // Distinct from `manual` on purpose: this lead is still being worked,
    // just somewhere else. Reading it as "unenrolled by hand" would make a
    // move look like a loss on both campaigns' Enrollments tabs.
    moved_by_user: "Moved to another campaign",
    campaign_deleted: "Campaign removed",
    appointment_cancelled: "Appointment cancelled",
    appointment_passed: "Appointment has been and gone",
  };
  return map[r] || reason || "";
}
