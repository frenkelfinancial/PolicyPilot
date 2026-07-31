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

/** Wait units a step may use. */
export const VC_WAIT_UNITS = ["minutes", "hours", "days"];

/** Step types. */
export const VC_STEP_TYPES = ["call", "double_dial"];

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
 * The rule that keeps a campaign from calling the whole book.
 *
 * Every group needs at least one POSITIVE (`is`) condition on a tag/lead-type
 * field. `is_not` does not count and that is the whole point: "lead type is not
 * trucker" excludes a sliver and admits everyone else, which is exactly the
 * rule someone types when they mean "everyone but truckers" and exactly the
 * campaign nobody meant to build.
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
    } else if (!g.conditions.some((c) => c.op === "is" && VC_TAG_FIELDS.includes(c.field))) {
      err = "Every group must name a lead type or campaign tag with an “is” condition " +
        `(${VC_TAG_FIELDS.join(", ")}) — otherwise this campaign could call your whole book.`;
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

/**
 * When a step becomes due, measured from when the PREVIOUS step completed.
 *
 * A zero wait is due immediately, which is what "call within a minute" degrades
 * to if someone types 0 — the drip rate, the slot limit and the gate chain are
 * what actually pace it.
 */
export function vcStepDueAt(from: string | Date, step: VcStep | null | undefined): Date {
  const base = asDate(from) || new Date();
  if (!step) return base;
  return new Date(base.getTime() + vcWaitMs(step.wait_value, step.wait_unit));
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
  stop_on_appointment_booked?: boolean | null;
  stop_on_sold?: boolean | null;
  stop_on_answered?: boolean | null;
  stop_answer_talk_secs?: number | null;
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

  const next = vcNextStep(steps, pos);
  if (!next) {
    return {
      status: "completed",
      current_step_position: pos,
      step_attempts: attempts,
      next_action_at: null,
      stop_reason: null,
      decision: "completed",
    };
  }

  return {
    status: "active",
    current_step_position: intOr(next.position, 0),
    step_attempts: 0,
    next_action_at: vcStepDueAt(now, next).toISOString(),
    stop_reason: null,
    decision: "next_step",
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
};

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
  };
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
    campaign_deleted: "Campaign removed",
  };
  return map[r] || reason || "";
}
