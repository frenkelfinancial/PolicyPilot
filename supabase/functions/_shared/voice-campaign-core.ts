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
// The campaign screen names what happened on a call, and what happened on a
// call is already named once, in the outcome -> lead effect table. Importing
// it is what stops "no answer" being worded two ways on two screens.
import { dispositionShortLabel, leadEffectForOutcome } from "./ai-lead-effect.ts";

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

/**
 * Enrollments one tick will TEXT for one agent.
 *
 * Four times the dial budget, because the two are bounded by different things.
 * A call occupies one of three concurrent slots for minutes and rings a human;
 * a text is one HTTPS request that is over before the next one starts. What
 * actually paces a text campaign is the step's own drip rate and the carrier's
 * throughput — this number exists only so one tick cannot run for ever.
 */
export const VC_MAX_SENDS_PER_TICK = 100;

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

/**
 * The two channels one campaign row can be.
 *
 * THE TABLE IS STILL CALLED voice_campaigns AND THAT IS HISTORICAL. A row with
 * `channel = 'sms'` is a texting campaign, run by this same engine: same
 * trigger matching, same enrollment model, same claim, same drip, same stop
 * machinery, same manual door, same seed_key. The alternative was a parallel
 * set of sms_* tables and a second tick, which is two of everything this file
 * exists to have exactly one of. See docs/sms-campaigns.md.
 */
export const VC_CHANNELS = ["voice", "sms"];

/** A campaign's channel, defaulting to voice — which is what every row was. */
export function vcChannel(campaign: VcCampaign | null | undefined): string {
  const raw = norm((campaign as { channel?: unknown } | null | undefined)?.channel);
  return VC_CHANNELS.includes(raw) ? raw : "voice";
}

/** "Voice" / "Text" — the badge on a campaign card. */
export function vcChannelLabel(channel: string | null | undefined): string {
  return norm(channel) === "sms" ? "Text" : "Voice";
}

/** The verb, for a sentence that has to name what a campaign does to somebody. */
export function vcChannelVerb(channel: string | null | undefined): string {
  return norm(channel) === "sms" ? "text" : "call";
}

/** Step types, per channel. A step of the wrong channel is refused by a DB trigger. */
export const VC_VOICE_STEP_TYPES = ["call", "double_dial"];
export const VC_SMS_STEP_TYPES = ["sms_message", "wait"];

/**
 * Every step type there is.
 *
 * Kept under its original name because the browser validates against it, but
 * a saver should use vcStepTypesFor(channel) — a `call` step in a text
 * campaign is the tick being told to dial somebody in a texting program, and
 * the database refuses it.
 */
export const VC_STEP_TYPES = [...VC_VOICE_STEP_TYPES, ...VC_SMS_STEP_TYPES];

export function vcStepTypesFor(channel: string | null | undefined): string[] {
  return norm(channel) === "sms" ? VC_SMS_STEP_TYPES.slice() : VC_VOICE_STEP_TYPES.slice();
}

/**
 * Does this step DO anything, or does it only pass time?
 *
 * `wait` is the one type that does not act. It exists because that is how a
 * person describes a text sequence — "send this, wait two days, send that" —
 * and it costs the engine nothing, because vcResolveNextDue() FOLDS its delay
 * into the next actionable step rather than waking up to do nothing.
 */
export function vcStepIsActionable(step: VcStep | null | undefined): boolean {
  return !!step && norm(step.step_type) !== "wait";
}

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
  /**
   * `sms_message` only: the message, with {{firstName}}-style variables still
   * in it. Rendered at SEND time, never stored rendered — the values change,
   * and a stored render texts somebody last month's coverage amount.
   */
  body?: string | null;
  /** `sms_message` only: a campaign-media URL. Its presence makes the send an MMS. */
  media_url?: string | null;
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

/**
 * The first step that actually DOES something.
 *
 * This is what "does this campaign have steps?" has to mean now that a step
 * can be a bare `wait`. A text campaign consisting of nothing but waits has
 * steps, passes any count-based check, and would enrol people and message
 * none of them for ever while showing green. Every guard that used to ask
 * vcFirstStep() asks this instead.
 */
export function vcFirstActionableStep(steps: VcStep[] | null | undefined): VcStep | null {
  return vcStepsSorted(steps).find((s) => vcStepIsActionable(s)) || null;
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
  /**
   * `wait` positions whose delay was FOLDED into `dueAt` rather than being
   * scheduled as work of their own. Always empty for a voice campaign, which
   * cannot contain a wait step — the database refuses one.
   */
  folded: number[];
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
 * AND THIS IS WHERE A `wait` STEP DISAPPEARS. A wait does no work, so waking
 * up to run it would burn a tick and a claim to accomplish nothing; instead its
 * delay is FOLDED into the next actionable step's due time. "Send / wait 2 days
 * / send" and a single step with a two-day wait therefore produce the identical
 * schedule and the identical number of ticks, and `current_step_position` never
 * lands on a step the tick would not know what to do with. Consecutive waits
 * add up. A sequence that ENDS in a wait completes when the last real step is
 * done, which is the only reading of it that is not a lie.
 *
 * A voice campaign cannot contain a wait step (the database refuses one), so
 * `folded` is always empty there and voice pacing is untouched — pinned by a
 * test that runs every voice fixture through this function before and after.
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
  const folded: number[] = [];
  let foldedMs = 0;

  for (const step of candidates) {
    if (!vcStepIsActionable(step)) {
      foldedMs += vcWaitMs(step.wait_value, step.wait_unit);
      folded.push(intOr(step.position, 0));
      continue;
    }
    if (!vcStepIsAnchored(step)) {
      // The folded waits move the BASE, then the step's own wait applies on
      // top of it — so a wait step and a step's own wait_value compose rather
      // than one silently replacing the other.
      const base = new Date(input.now.getTime() + foldedMs);
      return {
        step,
        dueAt: vcStepDueAt(base, step).toISOString(),
        skipped,
        folded,
        reason: "ok",
      };
    }
    const due = vcAnchoredDueAt(step, input.appointmentAt ?? null);
    if (!due) {
      // No appointment to count down to. Nothing about waiting makes this
      // resolvable, so say so rather than scheduling a call at "now".
      return { step: null, dueAt: null, skipped, folded, reason: "no_appointment" };
    }
    if (due.getTime() <= input.now.getTime()) {
      skipped.push(intOr(step.position, 0));
      continue;
    }
    return { step, dueAt: due.toISOString(), skipped, folded, reason: "ok" };
  }

  return {
    step: null,
    dueAt: null,
    skipped,
    folded,
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
  /** "voice" (default) or "sms". See VC_CHANNELS. */
  channel?: string | null;
  stop_on_appointment_booked?: boolean | null;
  stop_on_sold?: boolean | null;
  stop_on_answered?: boolean | null;
  stop_answer_talk_secs?: number | null;
  /** SMS only: end the enrollment when the lead writes back. Default true. */
  stop_on_reply?: boolean | null;
  /** SMS only: defer a step while a conversation is live. Default true. */
  pause_on_active_conversation?: boolean | null;
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
  /**
   * "voice" (default) or "sms". Defaulted so every existing caller keeps its
   * exact previous behaviour, which a test pins.
   */
  channel?: string | null;
  /**
   * VOICE: the lead's phone is on `suppression_list`.
   * SMS:   the lead's phone is on `dnc_list`.
   * Two different lists because they are two different permissions — the
   * caller picks the right one, so this stays pure and the distinction cannot
   * be lost inside a shared helper.
   */
  suppressed?: boolean;
  activeElsewhere?: boolean;
  hasPhone?: boolean;
  /**
   * SMS ONLY: an acceptable `consent_records` row exists for this lead's
   * phone. This is a DIFFERENT FACT from `leads.tcpa_consent` and reading the
   * voice one for a text campaign is the single worst mistake available here:
   * calling consent is not texting consent, the app has kept them apart
   * everywhere else, and collapsing them would message people who only ever
   * agreed to a phone call.
   */
  hasSmsConsent?: boolean;
}): VcEnrollVerdict {
  const { lead } = input;
  const channel = VC_CHANNELS.includes(norm(input.channel)) ? norm(input.channel) : "voice";
  const sms = channel === "sms";

  if (input.hasPhone === false) {
    return { ok: false, reason: "no_phone", detail: "no phone number on file" };
  }

  if (sms) {
    if (input.hasSmsConsent !== true) {
      return { ok: false, reason: "no_sms_consent", detail: "no text consent on file" };
    }
  } else if (lead.tcpa_consent !== true) {
    return { ok: false, reason: "no_consent", detail: "no consent" };
  }

  // `leads.dnc` is "they asked not to be contacted", and it stops BOTH
  // channels. It is written by the AI's dnc_request handling and by hand, and
  // a person who said that to somebody on the phone did not mean "but do text
  // me".
  if (lead.dnc === true) {
    return { ok: false, reason: "dnc", detail: "on your do-not-call list" };
  }
  if (input.suppressed === true) {
    return {
      ok: false,
      reason: "suppressed",
      detail: sms ? "opted out of texts" : "on the suppression list",
    };
  }
  // Orion's rule, kept and now PER CHANNEL: a lead in two voice campaigns gets
  // two robots in one afternoon, and neither campaign's stats mean anything
  // afterwards — and the same is true of two text campaigns. One of each is
  // fine and is the point: a speed-to-lead call sequence and a nurture drip
  // are complementary, and making an agent choose would make this feature
  // useless to anybody already running voice.
  if (input.activeElsewhere === true) {
    return {
      ok: false,
      reason: "already_enrolled",
      detail: sms ? "already in another text campaign" : "already in another voice campaign",
    };
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
  // Deliberately worded differently from `no_consent`, because they are
  // cleared by different actions: one is the calling attestation, the other is
  // the text-message box beside it. "3 no consent" on a text campaign would
  // send an agent to tick the wrong one.
  no_sms_consent: "no text consent",
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
  /** The campaign's channel, so the modal can say "text" where it means text. */
  channel: string;
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
  /**
   * lead_id → true when the lead's phone is suppressed FOR THIS CHANNEL —
   * `suppression_list` for voice, `dnc_list` for SMS. The caller reads the
   * right list; see vcEvaluateEnrollment.
   */
  suppressed: Set<string>;
  /** lead_id → true when the lead has a usable phone number. */
  hasPhone: Set<string>;
  /**
   * SMS campaigns only: lead_id → true when an acceptable `consent_records`
   * row exists. Ignored for a voice campaign, which reads `leads.tcpa_consent`
   * off the lead itself.
   */
  smsConsent?: Set<string>;
  /** lead_id → the soonest scheduled future appointment, for anchored campaigns. */
  appointments: Map<string, { id: string; starts_at: string }>;
  onConflict: "skip" | "move";
  campaign: VcCampaign | null | undefined;
  limit: number;
}): VcEnrollPlan {
  const byId = new Map<string, VcLead>();
  for (const l of input.leads || []) if (l && l.id) byId.set(String(l.id), l);

  const channel = vcChannel(input.campaign);
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
      channel,
      hasPhone: input.hasPhone.has(id),
      suppressed: input.suppressed.has(id),
      hasSmsConsent: !!input.smsConsent && input.smsConsent.has(id),
      // Withheld deliberately — the conflict is this function's decision to
      // make, because only here is "move them" an available answer.
      activeElsewhere: false,
    });
    if (!verdict.ok) {
      const reason = verdict.reason || "skipped";
      // Both consent refusals feed the same "Record consent first →" link;
      // which BOX that link pre-ticks is the modal's job, and it knows the
      // campaign's channel.
      if (reason === "no_consent" || reason === "no_sms_consent") noConsent.push(id);
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
    channel,
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
  paused: number;
  completed: number;
  stopped: number;
  calls: number;
  answers: number;
  appointments: number;
  /** Texts sent, for a channel = 'sms' campaign. */
  messages: number;
  /** Inbound messages received since enrollment. */
  replies: number;
}

/**
 * Roll enrollment rows into the numbers on the campaign card.
 *
 * Both channels' counters are summed and the CARD picks which to show. They
 * are separate columns rather than one shared "attempts" because "Calls
 * placed: 4" on a campaign that has never dialled anybody is a small lie, and
 * a card full of numbers only works if an agent believes all of them.
 */
export function vcCampaignStats(
  enrollments: Array<{
    status?: string | null;
    calls_placed?: number | null;
    answers?: number | null;
    appointments?: number | null;
    messages_sent?: number | null;
    replies?: number | null;
  }> | null | undefined,
): VcCampaignStats {
  const out: VcCampaignStats = {
    enrolled: 0, active: 0, paused: 0, completed: 0, stopped: 0,
    calls: 0, answers: 0, appointments: 0, messages: 0, replies: 0,
  };
  for (const e of enrollments || []) {
    out.enrolled++;
    const st = norm(e.status);
    if (st === "active") out.active++;
    else if (st === "paused") out.paused++;
    else if (st === "completed") out.completed++;
    else if (st === "stopped") out.stopped++;
    out.calls += Math.max(0, intOr(e.calls_placed, 0));
    out.answers += Math.max(0, intOr(e.answers, 0));
    out.appointments += Math.max(0, intOr(e.appointments, 0));
    out.messages += Math.max(0, intOr(e.messages_sent, 0));
    out.replies += Math.max(0, intOr(e.replies, 0));
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
    // What the campaign screen's Remove button writes. Distinct from `manual`
    // (the pre-mission-control wording, still on rows that carry it) so the
    // two are tellable apart forever in a stats table.
    removed_by_user: "Removed by hand",
    // Distinct from `manual` on purpose: this lead is still being worked,
    // just somewhere else. Reading it as "unenrolled by hand" would make a
    // move look like a loss on both campaigns' Enrollments tabs.
    moved_by_user: "Moved to another campaign",
    campaign_deleted: "Campaign removed",
    appointment_cancelled: "Appointment cancelled",
    appointment_passed: "Appointment has been and gone",
    // ---- Text campaigns -----------------------------------------------
    // The good ending, and it needs to read like one. `stop_on_reply` fires
    // on the outcome the whole sequence was for, so wording it as a failure
    // ("Stopped") would make a working campaign's Finished tab look like a
    // graveyard.
    replied: "They wrote back",
    opted_out: "Replied STOP",
    conversation_closed: "Conversation closed",
    no_sms_consent: "No text consent",
  };
  return map[r] || reason || "";
}

// ------------------------------------------------------------
// 11. Mission control — what the campaign screen says
//
// A campaign was a rule builder with a count on it. This section is what turns
// it into something an agent can WATCH: which leads it is calling, what
// happened on each, what is next, and — the part that was missing entirely —
// WHY a lead that is not being called is not being called.
//
// Every function here is pure and locale-free. None of them format a clock
// time: they return the instant and the renderer formats it, because a parity
// test that compared `toLocaleString` output would be testing the test runner's
// ICU data. `vcRelTime` is the exception and is deliberately built out of whole
// units so it says the same thing in every runtime.
// ------------------------------------------------------------

/** The three things a person may do to one lead's enrollment from the screen. */
export const VC_ENROLLMENT_OPS = ["pause", "resume", "remove"] as const;
export type VcEnrollmentOp = (typeof VC_ENROLLMENT_OPS)[number];

/**
 * "Step 2 of 6".
 *
 * `current_step_position` is the step that runs NEXT, so a lead that has had
 * one call out of six is on step 2 — which is also what the agent sees on the
 * Steps tab. A position that no longer exists (the step was deleted under a
 * live enrollment) still counts, because the tick will complete that
 * enrollment on its next pass and pretending otherwise would hide it.
 */
export function vcStepProgressLabel(
  position: unknown,
  steps: VcStep[] | null | undefined,
): string {
  const total = vcStepsSorted(steps).length;
  const pos = Math.max(1, intOr(position, 1));
  if (!total) return "No steps";
  return `Step ${Math.min(pos, total)} of ${total}`;
}

/**
 * "2h ago", "in 5m", "just now".
 *
 * Whole units only, largest that fits, never a decimal. A campaign screen
 * refreshing every ten seconds must not flicker between "1.9h" and "1.8h", and
 * the difference between 110 and 118 minutes is not a fact anybody acts on.
 */
export function vcRelTime(when: string | Date | null | undefined, now: Date): string {
  const t = asDate(when);
  if (!t) return "";
  const deltaMs = t.getTime() - now.getTime();
  const ahead = deltaMs > 0;
  const secs = Math.floor(Math.abs(deltaMs) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  let n: number, unit: string;
  if (mins < 60) { n = Math.max(1, mins); unit = "m"; }
  else if (mins < 60 * 24) { n = Math.floor(mins / 60); unit = "h"; }
  else { n = Math.floor(mins / (60 * 24)); unit = "d"; }
  return ahead ? `in ${n}${unit}` : `${n}${unit} ago`;
}

/** Why a lead is waiting, when the wait came from a gate refusal. */
export function vcWaitReasonLabel(code: string | null | undefined): string {
  const c = norm(code);
  if (!c) return "";
  const map: Record<string, string> = {
    quiet_hours: "Quiet hours where they live",
    daily_cap_reached: "Your daily call limit",
    // vcHandleGateRejection's catch-all. Naming the HTTP status would be
    // honest and useless; this says the true thing an agent can act on, which
    // is nothing, because it retries by itself.
    retry_soon: "A hiccup on the line — retrying",
    // ---- Text campaigns -----------------------------------------------
    // THESE TWO ARE THE WHOLE REASON THE HOLD IS VISIBLE. A drip that has gone
    // quiet because the lead is mid-conversation is the campaign working
    // exactly as designed, and with nothing on screen it is indistinguishable
    // from one that has broken.
    live_conversation: "They’re mid-conversation — holding",
    agent_takeover: "You’re handling this thread",
    daily_limit_reached: "Your carrier’s daily text limit",
    a2p_not_approved: "Texting registration not approved yet",
  };
  return map[c] || "";
}

export interface VcNextActionVerdict {
  /**
   * calling            — a call for this lead is in the air right now
   * paused_lead        — this one enrollment is held by hand
   * paused_campaign    — the whole campaign is paused (usually the wallet)
   * campaign_off       — the campaign's Active switch is off
   * ended              — stopped or completed; nothing is next
   * waiting_on_call    — a call went out and its result has not landed yet
   * due                — due now; the next tick takes it
   * scheduled          — `at` is when
   * unknown            — active with no next_action_at and no call in flight
   */
  kind:
    | "calling" | "paused_lead" | "paused_campaign" | "campaign_off"
    | "ended" | "waiting_on_call" | "due" | "scheduled" | "unknown";
  /** The instant, for the caller to format. Null for every other kind. */
  at: string | null;
  /** The gate code behind a `scheduled`, when there was one. */
  code: string | null;
}

/**
 * What happens to this lead next, and if nothing is going to, why not.
 *
 * THE WHOLE POINT IS THE NEGATIVE CASES. "Tomorrow 9:05 AM" on a screen an
 * agent opened because nothing seems to be happening reads as a broken
 * product; "Quiet hours where they live · next call 9:05 AM" reads as a
 * working one. The engine already knew every one of these reasons and threw
 * them all away.
 *
 * Order matters: a live call outranks a pause, because it is a fact about
 * right now, and an agent who pauses a lead mid-call needs to see that the
 * call is still up.
 */
export function vcNextAction(input: {
  enrollment: {
    status?: string | null;
    next_action_at?: string | null;
    claimed_at?: string | null;
    paused_at?: string | null;
    last_gate_code?: string | null;
  } | null | undefined;
  campaign?: { active?: boolean | null; paused_at?: string | null } | null;
  /** True when an ai_calls row for this lead is still in_progress. */
  inFlight?: boolean;
  now: Date;
}): VcNextActionVerdict {
  const e = input.enrollment || {};
  const none = (kind: VcNextActionVerdict["kind"]): VcNextActionVerdict =>
    ({ kind, at: null, code: null });

  if (input.inFlight) return none("calling");

  const status = norm(e.status);
  if (status === "paused") return { kind: "paused_lead", at: e.paused_at || null, code: null };
  if (status && status !== "active") return none("ended");

  // A claim with nothing due is the shape of a call that has gone out and
  // whose hangup has not come back yet. It is not an error and it is not a
  // pause — it is thirty seconds of a phone ringing.
  if (!e.next_action_at && e.claimed_at) return none("waiting_on_call");

  // The campaign's own state comes AFTER the enrollment's, because a paused
  // campaign whose lead is mid-call is still mid-call.
  const c = input.campaign || {};
  if (c.paused_at) return none("paused_campaign");
  if (c.active === false) return none("campaign_off");

  const at = asDate(e.next_action_at);
  if (!at) return none("unknown");
  if (at.getTime() <= input.now.getTime()) return { kind: "due", at: e.next_action_at || null, code: null };
  return { kind: "scheduled", at: e.next_action_at || null, code: norm(e.last_gate_code) || null };
}

/**
 * The sentence, given a time the caller has already formatted.
 *
 * Split from vcNextAction so the decision can be unit-tested and the clock
 * formatting can stay where the reader's locale is.
 *
 * `channel` defaults to "voice", so every pre-existing call site produces the
 * byte-identical string it always did — a test pins all nine kinds against
 * their original wording.
 */
export function vcNextActionText(
  verdict: VcNextActionVerdict,
  whenText: string,
  channel?: string | null,
): string {
  const when = String(whenText || "").trim();
  const sms = norm(channel) === "sms";
  switch (verdict.kind) {
    case "calling":         return sms ? "Sending now…" : "Calling now…";
    case "paused_lead":     return when ? `Paused ${when}` : "Paused";
    case "paused_campaign": return "Campaign paused";
    case "campaign_off":    return "Campaign switched off";
    case "ended":           return "—";
    case "waiting_on_call": return sms ? "Sending…" : "Call in progress…";
    case "due":             return "Due now";
    case "scheduled": {
      const reason = vcWaitReasonLabel(verdict.code);
      const tail = when ? `next ${sms ? "text" : "call"} ${when}` : "waiting";
      return reason ? `${reason} · ${tail}` : (when || "Scheduled");
    }
    default:                return "—";
  }
}

export interface VcLastCall {
  outcome?: string | null;
  status?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
}

/**
 * "No answer", "Appointment booked", "Calling now" — the last call's result,
 * worded exactly as the lead row words it.
 *
 * Reads through leadEffectForOutcome so a call's result has ONE set of words
 * in this app. A call still in progress is reported as such rather than as its
 * placeholder outcome.
 */
export function vcLastCallLabel(call: VcLastCall | null | undefined): string {
  if (!call) return "";
  if (norm(call.status) === "in_progress") return "Calling now";
  const disp = leadEffectForOutcome(call.outcome).disposition;
  if (disp) return dispositionShortLabel(disp);
  return norm(call.outcome) === "error" ? "Call failed" : "";
}

/** When the last call happened, for the relative stamp beside its result. */
export function vcLastCallAt(call: VcLastCall | null | undefined): string | null {
  if (!call) return null;
  return call.ended_at || call.created_at || null;
}

export interface VcFeedEntry {
  call_id: string;
  lead_id: string | null;
  /** The outcome this line is about, normalised. */
  outcome: string;
  /** good / bad / neutral, for the dot beside the line. */
  tone: "good" | "bad" | "neutral";
  /** "Booked an appointment with Lisa P." — the lead's name already in it. */
  headline: string;
  /** When it happened. */
  at: string | null;
  /** When this lead is next due, if the campaign is still working them. */
  retry_at: string | null;
}

const FEED_TONE: Record<string, "good" | "bad" | "neutral"> = {
  appointment_booked: "good",
  transferred: "good",
  qualified: "good",
  dnc_request: "bad",
  not_interested: "bad",
  error: "bad",
};

/**
 * One line of "what the AI is doing".
 *
 * Built from the ai_calls row that already exists — this feature adds NO
 * second event-logging system beside ai_call_events, which is the Telnyx
 * webhook's diagnostic trace and is service-role-only for good reasons.
 *
 * The name is handed in rather than looked up, because the browser holds the
 * book in memory and the server does not, and a feed that needed a join per
 * line would be a feed nobody could paginate.
 */
export function vcFeedEntry(
  call: {
    id?: string | null;
    lead_id?: string | null;
    outcome?: string | null;
    status?: string | null;
    ended_at?: string | null;
    created_at?: string | null;
    appointment_id?: string | null;
  } | null | undefined,
  ctx?: { leadName?: string | null; retryAt?: string | null },
): VcFeedEntry {
  const c = call || {};
  const who = String((ctx && ctx.leadName) || "").trim() || "a lead";
  const live = norm(c.status) === "in_progress";
  const outcome = live ? "in_progress" : norm(c.outcome);

  const headlines: Record<string, string> = {
    in_progress:        `Calling ${who}…`,
    appointment_booked: `Booked an appointment with ${who}`,
    transferred:        `Transferred ${who} to you`,
    qualified:          `Qualified ${who}`,
    callback_requested: `${who} asked for a callback`,
    dnc_request:        `${who} asked to stop — do-not-call recorded`,
    not_interested:     `${who} is not interested`,
    completed:          `Spoke with ${who}`,
    no_answer:          `Called ${who} — no answer`,
    voicemail:          `Called ${who} — voicemail`,
    busy:               `Called ${who} — busy`,
    error:              `Call to ${who} did not go through`,
  };

  return {
    call_id: String(c.id || ""),
    lead_id: c.lead_id ? String(c.lead_id) : null,
    outcome: outcome || "",
    tone: FEED_TONE[outcome] || "neutral",
    headline: headlines[outcome] || `Called ${who}`,
    at: c.ended_at || c.created_at || null,
    // A retry is only worth naming while the campaign is still going to make
    // one. A stopped enrollment's next_action_at is null, so this is null too.
    retry_at: (ctx && ctx.retryAt) || null,
  };
}

/**
 * The whole feed, newest first.
 *
 * `limit` is applied here rather than in the query so the caller can hand in
 * one page of calls and get a stable answer, and so the count in the header
 * and the rows underneath it come from the same array.
 */
export function vcFeed(
  calls: Array<Record<string, unknown>> | null | undefined,
  ctx: {
    leadName?: (leadId: string | null) => string;
    retryAt?: (leadId: string | null) => string | null;
    limit?: number;
  },
): VcFeedEntry[] {
  const rows = (calls || []).slice();
  rows.sort((a, b) => {
    const at = asDate((a.ended_at || a.created_at) as string) || new Date(0);
    const bt = asDate((b.ended_at || b.created_at) as string) || new Date(0);
    return bt.getTime() - at.getTime();
  });
  const limit = Math.max(0, intOr(ctx.limit, 50));
  return rows.slice(0, limit).map((c) => vcFeedEntry(c as never, {
    leadName: ctx.leadName ? ctx.leadName((c.lead_id as string) || null) : "",
    retryAt: ctx.retryAt ? ctx.retryAt((c.lead_id as string) || null) : null,
  }));
}

// ------------------------------------------------------------
// 12. Managing enrollments from the campaign — pause / resume / remove
//
// The same discipline as the manual enrollment door: ONE planner, called once,
// and the preview is the plan without the write. A preview computed by
// separate code is a preview that eventually lies, and these buttons make a
// promise about somebody's live calling program.
// ------------------------------------------------------------

export interface VcActionPlanItem {
  enrollment_id: string;
  lead_id: string | null;
  op: VcEnrollmentOp;
}

export interface VcActionPlan {
  op: VcEnrollmentOp;
  items: VcActionPlanItem[];
  /** reason → count. Every id handed in lands in items or in here, never both. */
  skipped: Record<string, number>;
}

const ACTION_SKIP_LABELS: Record<string, string> = {
  not_found: "not yours",
  not_active: "not running",
  not_paused: "not paused",
  already_ended: "already finished",
  // The one that needs the most words: pausing releases a lead from the
  // one-active-campaign rule, so somebody else may have taken them.
  active_elsewhere: "now in another campaign",
};

/**
 * Decide what pause / resume / remove means for a set of enrollments.
 *
 * PURE, and every rejection is REPORTED rather than dropped. "Nothing
 * happened" on a bulk button is the failure mode that makes agents stop
 * trusting bulk buttons.
 */
export function vcPlanEnrollmentAction(input: {
  op: VcEnrollmentOp;
  enrollment_ids: string[];
  /** id → the row, already scoped to the caller. Missing means "not yours". */
  byId: Map<string, { id: string; lead_id?: string | null; status?: string | null }>;
  /** lead_id of every lead this agent has ACTIVE somewhere else right now. */
  activeElsewhere?: Set<string>;
}): VcActionPlan {
  const op = (VC_ENROLLMENT_OPS as readonly string[]).includes(input.op) ? input.op : "pause";
  const items: VcActionPlanItem[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] || 0) + 1; };

  const seen = new Set<string>();
  for (const raw of input.enrollment_ids || []) {
    const id = String(raw == null ? "" : raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const row = input.byId.get(id);
    if (!row) { skip("not_found"); continue; }
    const status = norm(row.status);
    const leadId = row.lead_id ? String(row.lead_id) : null;

    if (op === "pause") {
      if (status !== "active") { skip(status === "paused" ? "not_active" : "already_ended"); continue; }
    } else if (op === "resume") {
      if (status !== "paused") { skip("not_paused"); continue; }
      // A paused enrollment does not hold the one-active-campaign slot, so
      // the lead may have been added to something else while it was down.
      // Resuming into that would break the partial unique index — and the
      // agent would get a raw 23505 instead of a sentence.
      if (leadId && input.activeElsewhere && input.activeElsewhere.has(leadId)) {
        skip("active_elsewhere");
        continue;
      }
    } else {
      if (status !== "active" && status !== "paused") { skip("already_ended"); continue; }
    }

    items.push({ enrollment_id: id, lead_id: leadId, op });
  }

  return { op, items, skipped };
}

/**
 * The sentence, in both tenses, from the same plan — exactly as the enrollment
 * door does it. "3 will be paused · 1 not running".
 */
export function vcEnrollmentActionSentence(plan: VcActionPlan, tense: "will" | "did" = "will"): string {
  const n = plan.items.length;
  const verb: Record<VcEnrollmentOp, [string, string]> = {
    pause:  ["will be paused", "paused"],
    resume: ["will resume", "resumed"],
    remove: ["will be removed", "removed"],
  };
  const [future, past] = verb[plan.op] || verb.pause;
  const parts = [`${n} ${tense === "will" ? future : past}`];
  const skips = Object.entries(plan.skipped || {})
    .filter(([, v]) => intOr(v, 0) > 0)
    .sort((a, b) => intOr(b[1], 0) - intOr(a[1], 0));
  for (const [reason, count] of skips) {
    parts.push(`${intOr(count, 0)} ${ACTION_SKIP_LABELS[reason] || String(reason).replace(/_/g, " ")}`);
  }
  return parts.join(" · ");
}

// ============================================================
// 13. TEXT CAMPAIGNS
//
// Everything above this line runs both channels. This section is what is true
// of a text campaign and not of a calling one — and it is deliberately short,
// because the parts worth reusing were reused rather than rewritten.
//
// What is NOT here, on purpose:
//
//   * No trigger matching. vcMatchesTriggerGroups is the same function.
//   * No enrollment gate. vcEvaluateEnrollment took a `channel` instead.
//   * No claim. The enrollment claim is channel-blind and always was.
//   * No drip. vcDripAllows counts rows in a window; the tick hands it rows
//     from sms_messages instead of ai_calls and the arithmetic is identical.
//   * No compliance. Consent, DNC, suppression and quiet hours are enforced by
//     runComplianceGate on the send itself, exactly as they are for a
//     hand-typed message. This file must never grow a copy of any of them.
// ============================================================

// ------------------------------------------------------------
// 13a. Merge variables
// ------------------------------------------------------------

/**
 * The six variables a message body may carry.
 *
 * Each one names a field that genuinely exists on a lead or an agent in this
 * schema. A palette offering {{policyNumber}} would be a promise the book
 * cannot keep, and the agent would find out when a consumer received the word
 * "there" in the middle of a sentence about their policy.
 *
 * EVERY VARIABLE HAS A FALLBACK AND NONE OF THEM IS BLANK. A blank leaves
 * "Hi , just checking in" on somebody's phone, which is worse than the generic
 * word it replaced. `{{agentPhone}}` falls back to "this number" because that
 * is always literally true: the lead is reading the message ON the number it
 * was sent from, so "call me on this number" works even when the lookup failed.
 */
export const VC_MERGE_VARS: Array<{
  key: string;
  label: string;
  /** What the editor's live preview shows. */
  sample: string;
  /** What a send uses when the real value is missing. Never blank. */
  fallback: string;
  /** Where the value comes from, for the palette's tooltip. */
  source: string;
}> = [
  { key: "firstName",      label: "First name",      sample: "Maria",           fallback: "there",         source: "the lead's first name" },
  { key: "agentName",      label: "Your name",       sample: "Jordan Reyes",    fallback: "your agent",    source: "your display name in Settings" },
  { key: "companyName",    label: "Your agency",     sample: "Reyes Financial", fallback: "our office",    source: "your agency name in Settings" },
  { key: "carrier",        label: "Carrier",         sample: "Mutual of Omaha", fallback: "your carrier",  source: "the lead's carrier field" },
  { key: "coverageAmount", label: "Coverage amount", sample: "$25,000",         fallback: "your coverage", source: "the lead's coverage field" },
  { key: "agentPhone",     label: "Your number",     sample: "(262) 509-9123",  fallback: "this number",   source: "the number this campaign texts from" },
];

const MERGE_BY_KEY = new Map(VC_MERGE_VARS.map((v) => [v.key.toLowerCase(), v]));

/** `{{ firstName }}`, `{{firstname}}`, `{{FirstName}}` — all the same variable. */
const MERGE_TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export interface VcMergeIssues {
  /** Variable names used in the body that this app cannot resolve. */
  unknown: string[];
  /** Known variables actually used, in first-appearance order. */
  used: string[];
}

/**
 * What is in this body, and what is wrong with it.
 *
 * The editor shows `unknown` in red BEFORE the campaign can be switched on,
 * because the alternative is discovering the typo from a consumer. The
 * renderer strips an unknown variable rather than leaving it, so this is the
 * only thing standing between `{{frstName}}` and a message that reads
 * "Hi , just checking in".
 */
export function vcMergeIssues(body: string | null | undefined): VcMergeIssues {
  const unknown: string[] = [];
  const used: string[] = [];
  const text = String(body === null || body === undefined ? "" : body);
  MERGE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MERGE_TOKEN_RE.exec(text)) !== null) {
    const raw = m[1];
    const known = MERGE_BY_KEY.get(raw.toLowerCase());
    if (known) {
      if (used.indexOf(known.key) === -1) used.push(known.key);
    } else if (unknown.indexOf(raw) === -1) {
      unknown.push(raw);
    }
  }
  return { unknown, used };
}

/**
 * Tidy up after a substitution.
 *
 * A variable that resolved to nothing leaves "Hi , how are you" and " ." — the
 * punctuation artefacts of a hole in a sentence. Every KNOWN variable has a
 * non-blank fallback so this is only reachable through an unknown one, but
 * that is exactly the case where the output is about to be read by a stranger.
 */
function tidyMerged(text: string): string {
  return String(text === null || text === undefined ? "" : text)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Render a body against a set of values.
 *
 * 🔴 A RAW `{{…}}` NEVER REACHES A PHONE. A known variable with no value gets
 * its fallback; an UNKNOWN variable is removed entirely. Leaving the braces in
 * would be the most obviously broken thing this feature could do, and
 * "somebody will notice in the editor" is not a mechanism.
 *
 * Rendering happens at SEND time, from the lead as they are at that moment.
 * Storing a rendered body would text somebody the coverage amount they had on
 * the day the campaign was written.
 */
export function renderMergeVars(
  body: string | null | undefined,
  values: Record<string, string | null | undefined> | null | undefined,
): string {
  const vals = values || {};
  const src = String(body === null || body === undefined ? "" : body);
  const out = src.replace(MERGE_TOKEN_RE, (_full: string, raw: string) => {
    const known = MERGE_BY_KEY.get(String(raw).toLowerCase());
    if (!known) return "";
    const v = vals[known.key];
    const s = v === null || v === undefined ? "" : String(v).trim();
    return s || known.fallback;
  });
  return tidyMerged(out);
}

/** The editor's live preview: the same renderer, against the sample values. */
export function vcMergePreview(body: string | null | undefined): string {
  const sample: Record<string, string> = {};
  for (const v of VC_MERGE_VARS) sample[v.key] = v.sample;
  return renderMergeVars(body, sample);
}

/**
 * A person's name, refusing an email address.
 *
 * THE SAME RULE AS `ppAgentName()` AND `pp_display_name()`, and it matters more
 * here than anywhere it is already enforced: those protect what a colleague
 * sees on a leaderboard, and this one decides what a CONSUMER is told the agent
 * is called. `agents.display_name` is null for most of the production book and
 * the historical fallback was the login email, so without this a campaign would
 * text strangers "Hi Maria, it's jacef8778099@gmail.com from our office."
 *
 * Derives from the local part rather than returning nothing, because a name
 * that is approximately right beats the words "your agent".
 */
export function vcPersonName(raw: string | null | undefined): string {
  const s = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!s) return "";
  if (s.indexOf("@") === -1) return s;
  const local = s.split("@")[0] || "";
  const cleaned = local.replace(/[._\-+]+/g, " ").replace(/\d+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** "+12625099123" -> "(262) 509-9123". Anything else is passed through. */
export function vcPrettyPhone(e164: string | null | undefined): string {
  const s = String(e164 === null || e164 === undefined ? "" : e164).trim();
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s);
  return m ? "(" + m[1] + ") " + m[2] + "-" + m[3] : s;
}

/**
 * Build the value map for one send.
 *
 * PURE, and every fact is handed in — which is what lets the editor's preview,
 * the Send Test and the drip all render through the identical function. A
 * preview computed by separate code is a preview that eventually lies, the same
 * rule the enrollment planner follows.
 */
export function vcMergeValues(input: {
  lead?: VcLead | null;
  agentName?: string | null;
  agencyName?: string | null;
  /** The number this campaign is texting FROM. */
  fromE164?: string | null;
}): Record<string, string> {
  const d = ((input.lead && input.lead.data) || {}) as Record<string, unknown>;
  const first = String(d.first_name === undefined || d.first_name === null ? "" : d.first_name).trim();
  const whole = String(d.name === undefined || d.name === null ? "" : d.name).trim();
  const rawName = first || whole.split(/\s+/)[0] || "";
  return {
    // A lead's own name is never an email — but the same guard costs nothing,
    // and a book imported from a CSV of addresses is not hypothetical.
    firstName: vcPersonName(rawName),
    agentName: vcPersonName(input.agentName),
    companyName: String(input.agencyName === null || input.agencyName === undefined ? "" : input.agencyName).trim(),
    carrier: String(d.carrier === undefined || d.carrier === null ? "" : d.carrier).trim(),
    coverageAmount: String(
      d.coverage_wanted !== undefined && d.coverage_wanted !== null
        ? d.coverage_wanted
        : (d.coverage_amount === undefined || d.coverage_amount === null ? "" : d.coverage_amount),
    ).trim(),
    agentPhone: vcPrettyPhone(input.fromE164),
  };
}

// ------------------------------------------------------------
// 13b. What a body costs, and whether it is sendable
// ------------------------------------------------------------

export interface VcBodyStats {
  /** Characters after rendering the SAMPLE values — what the agent is shown. */
  chars: number;
  segments: number;
  encoding: string;
  /** True once a non-GSM7 character has forced the 70-character segment. */
  unicode: boolean;
  /** The MMS flag: an attachment changes the billing shape entirely. */
  mms: boolean;
}

/**
 * How long this step's message is, priced the way a carrier prices it.
 *
 * Measured against the PREVIEW, not the raw body: `{{coverageAmount}}` is
 * seventeen characters of template and about seven of message, and an agent
 * shown the template's length would write to the wrong budget. It is still an
 * estimate — a lead called Bartholomew costs more than one called Jo — which is
 * why the editor says "about".
 *
 * The segment counter is passed IN rather than imported so this module keeps
 * running unchanged under `node --test` and inside the browser mirror; the
 * server hands it countSegments() from _shared/segments.ts, which is the
 * function the biller uses, so the estimate and the charge agree.
 */
export function vcBodyStats(
  body: string | null | undefined,
  opts?: {
    mediaUrl?: string | null;
    countSegments?: (t: string) => { segments: number; encoding: string };
  },
): VcBodyStats {
  const rendered = vcMergePreview(body);
  const counter = opts && opts.countSegments;
  const info = counter
    ? counter(rendered)
    : { segments: rendered.length ? Math.max(1, Math.ceil(rendered.length / 153)) : 0, encoding: "GSM7" };
  const media = String((opts && opts.mediaUrl) === null || (opts && opts.mediaUrl) === undefined ? "" : (opts && opts.mediaUrl)).trim();
  return {
    chars: rendered.length,
    segments: rendered.length ? Math.max(1, intOr(info.segments, 1)) : 0,
    encoding: info.encoding || "GSM7",
    unicode: (info.encoding || "GSM7") !== "GSM7",
    mms: !!media,
  };
}

/**
 * Is this campaign's step list fit to be switched on?
 *
 * The browser half of the rule voice_campaigns_validate() enforces in the
 * database. Two enforcement points on purpose, the same arrangement the tag
 * rule has: this one produces a sentence in the editor, that one refuses the
 * write whatever produced it.
 */
export function vcValidateSmsSteps(steps: VcStep[] | null | undefined): VcValidation {
  const all = vcStepsSorted(steps);
  const msgs = all.filter((s) => norm(s.step_type) === "sms_message");
  const groupErrors: (string | null)[] = [];
  let firstError: string | null = null;

  for (const s of all) {
    let err: string | null = null;
    if (norm(s.step_type) === "sms_message") {
      if (!String(s.body === null || s.body === undefined ? "" : s.body).trim()) {
        err = "This step has no message text.";
      } else {
        const issues = vcMergeIssues(s.body);
        if (issues.unknown.length) {
          err = "There is no such variable as {{" + issues.unknown[0] + "}}. Pick one from the list: " +
            VC_MERGE_VARS.map((v) => "{{" + v.key + "}}").join(", ") + ".";
        }
      }
    }
    groupErrors.push(err);
    if (err && !firstError) firstError = err;
  }

  if (!firstError && !msgs.length) {
    firstError = all.length
      ? "This campaign only waits — add a message step, or it will enrol people and never text them."
      : "Add at least one message step.";
  }

  return { ok: !firstError, error: firstError, groupErrors };
}

// ------------------------------------------------------------
// 13c. The live-conversation hold
// ------------------------------------------------------------

/**
 * How long after a lead's message the thread still counts as a conversation.
 *
 * Twenty-four hours, which is deliberately generous. The failure this exists to
 * prevent — a canned step landing in the middle of a real exchange — is
 * embarrassing and is remembered; the cost of the hold is that a drip step
 * lands a day later than planned, which nobody notices.
 */
export const VC_SMS_CONVERSATION_WINDOW_HOURS = 24;

/**
 * How often a thread the agent has taken over is re-checked.
 *
 * A takeover has no stated expiry — it ends when the agent switches the AI back
 * on, or never. Re-asking hourly is cheap and honest; leaving the enrollment
 * due would re-ask sixty times an hour, and stopping it would throw away a
 * sequence because somebody answered one message by hand.
 */
export const VC_SMS_TAKEOVER_RECHECK_MINUTES = 60;

export interface VcSmsThreadFacts {
  status?: string | null;
  closed_reason?: string | null;
  ai_muted?: boolean | null;
  ai_muted_reason?: string | null;
  last_inbound_at?: string | Date | null;
  last_outbound_at?: string | Date | null;
}

export interface VcSmsHoldVerdict {
  hold: boolean;
  /** The gate code stored on the enrollment, so the screen can explain itself. */
  reason: "live_conversation" | "agent_takeover" | null;
  /** ISO instant to come back at. Null when there is no hold. */
  until: string | null;
}

/**
 * Should this step wait because somebody is actually talking to this lead?
 *
 * 🔴 THIS IS NOT A STOP AND IT IS NOT A PAUSE. The enrollment stays active and
 * keeps its place in the sequence; only the due time moves. A lead who asks a
 * question on Tuesday and gets no further answer still receives Thursday's step
 * on Thursday — they simply do not receive it on top of their own sentence.
 *
 * A takeover outranks the inbound window because it has no expiry: an agent
 * working a thread by hand at 4pm on a message from yesterday morning is still
 * working it, and the 24-hour clock would already have run out.
 */
export function vcEvaluateSmsHold(input: {
  campaign: VcCampaign;
  thread?: VcSmsThreadFacts | null;
  now: Date;
}): VcSmsHoldVerdict {
  const none: VcSmsHoldVerdict = { hold: false, reason: null, until: null };
  // Off is off. An agent who unticked this asked for the sequence to run on its
  // own schedule and is entitled to get that.
  if (input.campaign.pause_on_active_conversation === false) return none;
  const t = input.thread;
  if (!t) return none;

  // A closed thread is not a live conversation — it is an opt-out, and that is
  // a stop, decided by vcEvaluateSmsStop above this in the tick.
  if (norm(t.status) === "closed") return none;

  if (t.ai_muted === true && norm(t.ai_muted_reason) === "agent_takeover") {
    return {
      hold: true,
      reason: "agent_takeover",
      until: new Date(input.now.getTime() + VC_SMS_TAKEOVER_RECHECK_MINUTES * 60000).toISOString(),
    };
  }

  const last = asDate(t.last_inbound_at === undefined ? null : t.last_inbound_at);
  if (last) {
    const expires = last.getTime() + VC_SMS_CONVERSATION_WINDOW_HOURS * 3600000;
    if (expires > input.now.getTime()) {
      return { hold: true, reason: "live_conversation", until: new Date(expires).toISOString() };
    }
  }

  return none;
}

// ------------------------------------------------------------
// 13d. Stopping a text sequence
// ------------------------------------------------------------

/**
 * Should this enrollment end?
 *
 * The text twin of vcEvaluateStop, and the ORDER carries the same meaning: the
 * refusals that protect a CONSUMER sit above every rule that is a campaign
 * setting. An agent who unticked "stop on reply" has not thereby asked for a
 * STOP to be ignored.
 *
 *   1. DNC — unconditional, from either list and from the lead's own flag.
 *   2. The thread was CLOSED, which only an opt-out does.
 *   3. stop_on_appointment_booked
 *   4. stop_on_sold
 *   5. stop_on_reply, and they have written since they were enrolled.
 *
 * Rule 5 is measured against `enrolledAt`, not against "any inbound ever".
 * Keying it on the thread alone would immediately stop everybody who had ever
 * replied to anything, which is most of a working book.
 */
export function vcEvaluateSmsStop(input: {
  campaign: VcCampaign;
  thread?: VcSmsThreadFacts | null;
  /** When this enrollment started — the clock stop_on_reply is measured from. */
  enrolledAt?: string | Date | null;
  leadSold?: boolean;
  leadBooked?: boolean;
  /** `leads.dnc`. */
  leadDnc?: boolean;
  /** A `dnc_list` row exists for this contact (agent-scoped or global). */
  onDncList?: boolean;
}): VcStopVerdict {
  const campaign = input.campaign;
  const thread = input.thread;

  if (input.leadDnc === true || input.onDncList === true) {
    return { stop: true, reason: "dnc" };
  }
  if (thread && norm(thread.status) === "closed") {
    return {
      stop: true,
      reason: norm(thread.closed_reason) === "opted_out" ? "opted_out" : "conversation_closed",
    };
  }
  if (campaign.stop_on_appointment_booked && input.leadBooked === true) {
    return { stop: true, reason: "appointment_booked" };
  }
  if (campaign.stop_on_sold && input.leadSold === true) {
    return { stop: true, reason: "sold" };
  }
  // Default TRUE — an unset column on a hand-made row reads as "yes", which is
  // the safe direction: continuing to drip at somebody who wrote back is the
  // failure this feature would be blamed for.
  if (campaign.stop_on_reply !== false) {
    const since = asDate(input.enrolledAt === undefined ? null : input.enrolledAt);
    const last = asDate(thread && thread.last_inbound_at !== undefined ? thread.last_inbound_at : null);
    if (last && (!since || last.getTime() > since.getTime())) {
      return { stop: true, reason: "replied" };
    }
  }
  return { stop: false, reason: null };
}

/**
 * Where an enrollment goes after one of its texts went out.
 *
 * Far simpler than the call version, and the missing pieces are the point:
 * there is no double-dial (a second text a minute later is not a retry, it is a
 * second text) and no "did they answer" (a delivery receipt is not a
 * conversation). What happens after a send is: work out the next step.
 *
 * Stopping is evaluated BEFORE the send by the tick, not here, because the
 * facts it reads — the thread, the lead's status — are read in the same breath
 * as the hold check, and re-reading them after a send would cost a round trip
 * to learn nothing new.
 */
export function vcAdvanceAfterSend(input: {
  steps: VcStep[];
  enrollment: VcEnrollmentState;
  now: Date;
}): VcAdvance {
  const pos = intOr(input.enrollment.current_step_position, 0);
  const resolved = vcResolveNextDue({ steps: input.steps, fromPosition: pos, now: input.now });

  if (!resolved.step || !resolved.dueAt) {
    return {
      status: "completed",
      current_step_position: pos,
      step_attempts: intOr(input.enrollment.step_attempts, 0),
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
// 13e. What to do when the send gate says no
// ------------------------------------------------------------

/**
 * Every way a campaign text can be refused, and what the campaign does about
 * it. The voice table's exact three behaviours, chosen per code — see
 * vcHandleGateRejection, whose reasoning holds here unchanged.
 *
 * The codes come from runComplianceGate, resolveTextingNumber and
 * sendMessageCore, which is to say: from the same functions that refuse a
 * hand-typed message. This engine reimplements none of them and only decides
 * what a SCHEDULER does with the answer.
 *
 *   RESCHEDULE  the refusal has a knowable expiry — quiet hours end, the
 *               carrier's daily window rolls over at midnight UTC.
 *   PAUSE       the refusal is about the ACCOUNT: the registration, the sending
 *               number, the wallet. Every enrollment would get the same answer,
 *               so stop and put a sentence on the card.
 *   STOP        the refusal is about this LEAD and will not change on its own:
 *               they opted out, their consent was revoked, the number is not a
 *               number.
 */
export function vcHandleSmsRejection(input: {
  code: string;
  now: Date;
  /** From vcNextAllowedInstant — when the lead's local window reopens. */
  quietUntil?: string | null;
}): VcRejectionPlan {
  const code = norm(input.code);
  const plan = (over: Partial<VcRejectionPlan>): VcRejectionPlan => Object.assign({
    action: "reschedule" as VcRejectionAction,
    next_action_at: null as string | null,
    stop_reason: null as string | null,
    pause_reason: null as string | null,
    leaveDue: false,
  }, over);

  switch (code) {
    // Computed with the SAME predicate the gate uses, for the same reason the
    // voice path does it: "when does it open" and "is it open" must not become
    // two answers.
    case "quiet_hours": {
      const at = asDate(input.quietUntil === undefined ? null : input.quietUntil) ||
        new Date(input.now.getTime() + 30 * 60 * 1000);
      return plan({ action: "reschedule", next_action_at: at.toISOString() });
    }

    // The sole-proprietor 10DLC throughput ceiling. It is a CARRIER limit
    // counted per UTC day and it resets at midnight UTC — which
    // messaging-shared.ts says in as many words in its own refusal — so that is
    // when to come back, not in five minutes, twelve times an hour, for the
    // rest of the evening.
    case "daily_limit_reached": {
      const at = new Date(input.now.getTime());
      at.setUTCHours(24, 0, 0, 0);
      return plan({ action: "reschedule", next_action_at: at.toISOString() });
    }

    // ---- Account-level. Pause and SAY SO on the card. ---------------------
    case "a2p_not_approved":
      return plan({
        action: "pause_campaign",
        pause_reason: "Paused: your texting registration is not approved yet. Texts cannot go out until it is.",
        leaveDue: true,
      });
    case "no_sms_capable_number":
      return plan({
        action: "pause_campaign",
        pause_reason: "Paused: none of your numbers is set up for texting yet. Check Settings → Texting.",
        leaveDue: true,
      });
    case "insufficient_balance":
      return plan({
        action: "pause_campaign",
        pause_reason: "Paused: your wallet is empty. Top up to resume.",
        leaveDue: true,
      });
    case "upgrade_required":
      return plan({
        action: "pause_campaign",
        pause_reason: "Paused: text campaigns need the Pro Producer or Team Leader plan.",
        leaveDue: true,
      });

    // ---- About this lead, and permanent until something else changes it. ---
    // `no_consent` here is a REVOCATION discovered at send time: the enrollment
    // gate already refused anybody without consent, so reaching this means it
    // went away underneath a live sequence.
    case "no_consent":
      return plan({ action: "stop_enrollment", stop_reason: "no_sms_consent" });
    case "on_dnc_list":
      return plan({ action: "stop_enrollment", stop_reason: "opted_out" });
    case "invalid_phone":
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

// ------------------------------------------------------------
// 13f. What the campaign screen says about a text
// ------------------------------------------------------------

export interface VcSmsMessageFacts {
  id?: string | null;
  direction?: string | null;
  sent_by?: string | null;
  body?: string | null;
  status?: string | null;
  delivered_at?: string | null;
  failed_reason?: string | null;
  created_at?: string | null;
  lead_id?: string | null;
}

/**
 * "Delivered", "Sent", "Did not send" — the last message's fate.
 *
 * Delivery is a real distinction on SMS in a way it is not on a call: a text
 * Telnyx accepted and a carrier silently dropped looks identical from here
 * unless the receipt is read, and "sent" claiming more than it knows is how an
 * agent concludes the feature works when it does not.
 */
export function vcMessageStatusLabel(msg: VcSmsMessageFacts | null | undefined): string {
  if (!msg) return "";
  if (msg.delivered_at) return "Delivered";
  const st = norm(msg.status);
  if (st === "failed") return "Did not send";
  if (st === "sent" || st === "queued") return "Sent";
  return st ? st.charAt(0).toUpperCase() + st.slice(1) : "";
}

/** When the last message happened, for the relative stamp beside its result. */
export function vcMessageAt(msg: VcSmsMessageFacts | null | undefined): string | null {
  if (!msg) return null;
  return msg.delivered_at || msg.created_at || null;
}

/**
 * One line of "what this campaign has been doing", for a text campaign.
 *
 * Built from the sms_messages rows that already exist — this feature adds NO
 * second event log, exactly as the voice feed adds none beside ai_calls. An
 * inbound line is included and is the most important line on the screen: it is
 * the moment a drip turned into a conversation.
 */
export function vcSmsFeedEntry(
  msg: VcSmsMessageFacts | null | undefined,
  ctx?: { leadName?: string | null; retryAt?: string | null },
): VcFeedEntry {
  const m = msg || {};
  const who = String((ctx && ctx.leadName) || "").trim() || "a lead";
  const inbound = norm(m.direction) === "inbound";
  const failed = norm(m.status) === "failed";
  const preview = String(m.body === null || m.body === undefined ? "" : m.body)
    .replace(/\s+/g, " ").trim().slice(0, 80);

  let outcome: string;
  let headline: string;
  let tone: "good" | "bad" | "neutral";
  if (inbound) {
    outcome = "replied";
    tone = "good";
    headline = preview ? who + " replied: “" + preview + "”" : who + " replied";
  } else if (failed) {
    outcome = "failed";
    tone = "bad";
    headline = "Text to " + who + " did not send";
  } else if (m.delivered_at) {
    outcome = "delivered";
    tone = "neutral";
    headline = preview ? "Delivered to " + who + ": “" + preview + "”" : "Delivered to " + who;
  } else {
    outcome = "sent";
    tone = "neutral";
    headline = preview ? "Texted " + who + ": “" + preview + "”" : "Texted " + who;
  }

  return {
    call_id: String(m.id || ""),
    lead_id: m.lead_id ? String(m.lead_id) : null,
    outcome,
    tone,
    headline,
    at: m.delivered_at || m.created_at || null,
    retry_at: (ctx && ctx.retryAt) || null,
  };
}

/** The whole text feed, newest first. Same shape and limit rule as vcFeed. */
export function vcSmsFeed(
  messages: Array<Record<string, unknown>> | null | undefined,
  ctx: {
    leadName?: (leadId: string | null) => string;
    retryAt?: (leadId: string | null) => string | null;
    limit?: number;
  },
): VcFeedEntry[] {
  const rows = (messages || []).slice();
  rows.sort((a, b) => {
    const at = asDate(a.created_at as string) || new Date(0);
    const bt = asDate(b.created_at as string) || new Date(0);
    return bt.getTime() - at.getTime();
  });
  const limit = Math.max(0, intOr(ctx.limit, 50));
  return rows.slice(0, limit).map((m) => vcSmsFeedEntry(m as VcSmsMessageFacts, {
    leadName: ctx.leadName ? ctx.leadName((m.lead_id as string) || null) : "",
    retryAt: ctx.retryAt ? ctx.retryAt((m.lead_id as string) || null) : null,
  }));
}

// ------------------------------------------------------------
// 13g. The daily text meter
// ------------------------------------------------------------

/**
 * 🔴 THERE IS NO TEXT CAP THIS ROUND, AND THIS DOES NOT MAKE ONE.
 *
 * `ai_daily_call_cap` and the ~300/number/day recommendation exist because a
 * number that dials too much gets spam-labelled by carriers. Texting has its
 * own throughput rules and they are ENFORCED ELSEWHERE and differently: a 10DLC
 * campaign carries a carrier-assigned throughput, and the sole-proprietor
 * ~1,000/day ceiling is already refused by runComplianceGate with its own
 * message and its own reset time. Inventing a second, made-up number here and
 * calling it a recommendation would be advice nobody can support.
 *
 * So this counts, and says the count. That is all it does.
 */
export interface VcSmsMeterRow {
  e164: string;
  sent: number;
}

export function vcSmsDailyByNumber(
  messages: Array<{ from_number?: string | null }> | null | undefined,
): VcSmsMeterRow[] {
  const by: Record<string, number> = {};
  for (const m of messages || []) {
    const e = m && typeof m.from_number === "string" ? m.from_number.trim() : "";
    if (!e) continue;
    by[e] = (by[e] || 0) + 1;
  }
  return Object.keys(by)
    .sort((a, b) => (by[b] - by[a]) || (a < b ? -1 : a > b ? 1 : 0))
    .map((e164) => ({ e164, sent: by[e164] }));
}

/** "412 texts sent today across 2 numbers." Plain counting, no verdict. */
export function vcSmsMeterSentence(rows: VcSmsMeterRow[] | null | undefined): string {
  const list = rows || [];
  const total = list.reduce((s, r) => s + Math.max(0, intOr(r.sent, 0)), 0);
  if (!list.length || !total) return "No texts sent today.";
  const n = list.filter((r) => intOr(r.sent, 0) > 0).length;
  return total + " text" + (total === 1 ? "" : "s") + " sent today" +
    (n > 1 ? " across " + n + " numbers." : ".");
}
