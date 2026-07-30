// ============================================================
// ai-call-meter.ts
// Daily AI-call metering: how many calls today, how many we RECOMMEND, and
// whether the agent's own cap has been reached.
//
// ---- The philosophy, because it is the whole design ------------------------
//
// Carriers flag numbers that blast hundreds of calls a day as "Spam Likely",
// and a brand-new number is at its most fragile in its first week. So this
// module METERS and RECOMMENDS. It does not police.
//
//   * The RECOMMENDATION (~300/day per active number, ramped over the first
//     seven days a number carries AI traffic) is advice. Passing it never
//     blocks a call — it records one warning event for the day and turns the
//     meter amber.
//   * The CAP is the agent's own number, stored on their row. Blocking there
//     is fine: they chose it. NULL means no cap at all, and that is a
//     supported, one-click state — not a misconfiguration.
//
// An agent who wants 500 calls a day on one number gets a clear warning about
// what that does to the number's reputation, and then gets their 500 calls.
// The upsell ("add another AI number and the recommendation goes up") is a
// line of copy, never a wall.
//
// ---- Purity ----------------------------------------------------------------
//
// Dependency-free (no supabase, no Deno globals) so it runs under BOTH
// `node --test` (ai-call-meter.test.ts) and the Deno edge runtime
// (ai-call-start). The BROWSER mirror of this math is the `// <ai-meter-core>`
// block in app.html; test/ai-meter.test.mjs runs a shared table of cases
// through BOTH and asserts they agree. Same arrangement as pcNormalizeCode()
// vs pc_normalize_code(). If you change a rule here, change it there.
// ============================================================

/** Calls per day per active AI number that we recommend not exceeding. */
export const AI_DAILY_CALL_RECOMMENDATION = 300;

/**
 * A new number's recommended volume for each of its first seven days of AI
 * use. Index 0 is day 1 (the calendar day it first carries an AI call).
 * From day 8 on, a number is recommended at AI_DAILY_CALL_RECOMMENDATION.
 */
export const AI_RAMP_SCHEDULE = [30, 60, 100, 150, 200, 250, 300];

/** Length of the ramp, in days. Derived — never write 7 in two places. */
export const AI_RAMP_DAYS = AI_RAMP_SCHEDULE.length;

/**
 * What `agents.ai_daily_call_cap` is set to for a new agent, and what every
 * existing row was backfilled to. The recommendation IS the default cap:
 * clearing or raising it is one click, so this is a strong default, not a
 * mandate.
 */
export const AI_DEFAULT_DAILY_CAP = 300;

/**
 * The day-boundary timezone when the agent has none stored.
 *
 * `agents.timezone` is written by the browser from
 * Intl.DateTimeFormat().resolvedOptions().timeZone, so for anyone who has
 * opened the app it is the zone their own clock is in — which is the only
 * honest meaning of "today". America/Chicago is the house default (it is what
 * every other schedule in this project reasons in) for a row that has never
 * been stamped.
 */
export const AI_METER_DEFAULT_TZ = "America/Chicago";

// ------------------------------------------------------------
// Timezone helpers
// ------------------------------------------------------------

/** True if `tz` is an IANA zone this runtime actually knows. */
export function isValidTimezone(tz: unknown): boolean {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone an agent's day rolls over in.
 *
 * Two steps and no guessing. There is deliberately NO area-code inference
 * here: the browser knows the agent's real zone and writes it, and inferring a
 * PERSON's timezone from a phone number they bought online is the kind of
 * almost-right that puts a call on the wrong day.
 */
export function resolveAgentTimezone(
  agent: { timezone?: unknown } | null | undefined,
): string {
  const tz = agent && typeof agent.timezone === "string" ? agent.timezone.trim() : "";
  return isValidTimezone(tz) ? tz : AI_METER_DEFAULT_TZ;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/**
 * How far `timeZone` is from UTC at the instant `date`, in milliseconds.
 * Positive east of UTC. Derived from what the zone actually renders, so DST is
 * handled by the platform rather than by a table we would have to maintain.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const p: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  // Intl renders midnight as hour 24 in some ICU versions.
  const hour = p.hour === 24 ? 0 : p.hour;
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  // Second-align the reference so the sub-second component does not leak into
  // the offset.
  return asIfUtc - (date.getTime() - date.getUTCMilliseconds());
}

/** The calendar date `date` falls on in `timeZone`, as `YYYY-MM-DD`. */
export function localDayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const p: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return `${p.year}-${p.month}-${p.day}`;
}

/** `YYYY-MM-DD` shifted by whole calendar days. Pure date arithmetic. */
export function addDays(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000,
  );
}

/**
 * The instant midnight local time begins, for the calendar date `dayKey` in
 * `timeZone`.
 *
 * Solved by fixed point rather than by adding a constant offset: the offset at
 * UTC-midnight and the offset at LOCAL-midnight differ across a DST boundary,
 * and one pass would land an hour out twice a year. Two passes converge for
 * every real-world zone.
 */
export function localMidnightUtc(dayKey: string, timeZone: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  let ms = base - tzOffsetMs(new Date(base), timeZone);
  ms = base - tzOffsetMs(new Date(ms), timeZone);
  return new Date(ms);
}

export interface DayWindow {
  /** The local calendar date, `YYYY-MM-DD`. */
  dayKey: string;
  /** Inclusive start of the local day, as a UTC ISO string. */
  startIso: string;
  /** EXCLUSIVE end of the local day, as a UTC ISO string. */
  endIso: string;
  timezone: string;
}

/**
 * The half-open UTC window `[local midnight, next local midnight)` containing
 * `date` in `timeZone`.
 *
 * Half-open like every other range in this app: a call placed at exactly
 * midnight belongs to the new day, once.
 */
export function localDayWindow(date: Date, timeZone: string): DayWindow {
  const tz = isValidTimezone(timeZone) ? timeZone : AI_METER_DEFAULT_TZ;
  const dayKey = localDayKey(date, tz);
  return {
    dayKey,
    startIso: localMidnightUtc(dayKey, tz).toISOString(),
    endIso: localMidnightUtc(addDays(dayKey, 1), tz).toISOString(),
    timezone: tz,
  };
}

// ------------------------------------------------------------
// Ramp-up
// ------------------------------------------------------------

/** A number as the meter needs to see it. */
export interface MeterNumber {
  e164?: string | null;
  /** phone_numbers.ai_first_used_at — null until it carries its first AI call. */
  ai_first_used_at?: string | Date | null;
}

/**
 * Which ramp day a number is on, 1-based, in the agent's timezone.
 *
 * A number that has NEVER carried an AI call reports day 1, not day 0 — the
 * moment it carries one it IS day 1, and answering "unknown" here would mean
 * either excluding a usable number from the pool or handing a fresh number the
 * full 300 on its very first day. Day 1 is the safe and the true answer.
 *
 * A first-use stamp in the future (clock skew) also reports day 1.
 */
export function rampDayIndex(
  firstUsedAt: string | Date | null | undefined,
  now: Date,
  timeZone: string,
): number {
  const tz = isValidTimezone(timeZone) ? timeZone : AI_METER_DEFAULT_TZ;
  if (firstUsedAt === null || firstUsedAt === undefined || firstUsedAt === "") return 1;
  const first = firstUsedAt instanceof Date ? firstUsedAt : new Date(String(firstUsedAt));
  if (Number.isNaN(first.getTime())) return 1;
  const day = daysBetween(localDayKey(first, tz), localDayKey(now, tz)) + 1;
  return day < 1 ? 1 : day;
}

/** Recommended calls today for one number, given where it is in its ramp. */
export function numberRampValue(
  firstUsedAt: string | Date | null | undefined,
  now: Date,
  timeZone: string,
): number {
  const day = rampDayIndex(firstUsedAt, now, timeZone);
  if (day > AI_RAMP_DAYS) return AI_DAILY_CALL_RECOMMENDATION;
  return Math.min(AI_DAILY_CALL_RECOMMENDATION, AI_RAMP_SCHEDULE[day - 1]);
}

export interface RampNumber {
  e164: string;
  last4: string;
  /** 1-based ramp day. Values above AI_RAMP_DAYS are out of the ramp. */
  day: number;
  inRamp: boolean;
  recommended: number;
  /** True when the number has never carried an AI call. */
  neverUsed: boolean;
}

export interface Recommendation {
  /**
   * Total recommended AI calls today across the pool, or NULL when the agent
   * has no active number at all. Null is not zero: there is no pool to
   * protect, and treating "no numbers" as a recommendation of 0 would flag
   * every call on an account that cannot dial anyway.
   */
  recommended: number | null;
  numbers: RampNumber[];
  numberCount: number;
  /** The subset still inside their first seven days. */
  ramping: RampNumber[];
}

/** Sum of every active number's ramp value. The recommendation. */
export function recommendedDailyCalls(
  numbers: MeterNumber[] | null | undefined,
  now: Date,
  timeZone: string,
): Recommendation {
  const rows: RampNumber[] = (numbers || []).map((n) => {
    const e164 = typeof n.e164 === "string" ? n.e164 : "";
    const day = rampDayIndex(n.ai_first_used_at, now, timeZone);
    return {
      e164,
      last4: e164.replace(/\D/g, "").slice(-4),
      day,
      inRamp: day <= AI_RAMP_DAYS,
      recommended: numberRampValue(n.ai_first_used_at, now, timeZone),
      neverUsed: !n.ai_first_used_at,
    };
  });
  return {
    recommended: rows.length ? rows.reduce((s, r) => s + r.recommended, 0) : null,
    numbers: rows,
    numberCount: rows.length,
    ramping: rows.filter((r) => r.inRamp),
  };
}

// ------------------------------------------------------------
// The verdict
// ------------------------------------------------------------

export type PaceState = "normal" | "over_recommendation" | "at_cap";

export interface PaceVerdict {
  callsToday: number;
  /** The agent's own cap. NULL = no cap, deliberately. */
  cap: number | null;
  recommended: number | null;
  state: PaceState;
  /** TRUE only at the agent's OWN cap. The recommendation never blocks. */
  blocked: boolean;
  /** The next call goes beyond the recommended pace. Informational. */
  overRecommendation: boolean;
  /** Calls left before the cap; null when there is no cap. */
  remaining: number | null;
}

/**
 * Where this agent stands right now, for both the gate and the meter.
 *
 * ONE threshold, used by both, so the screen can never look green for a call
 * the server would refuse (or amber for one it would not warn about):
 * `callsToday >= limit` means "the call about to be placed is beyond it".
 *
 * `overRecommendation` requires !blocked on purpose — a call that is never
 * going to be placed should not leave a warning behind saying it was.
 */
export function evaluateDailyPace(input: {
  callsToday: number;
  cap?: number | null;
  recommended?: number | null;
}): PaceVerdict {
  const callsToday = Number.isFinite(input.callsToday) ? Math.max(0, Math.trunc(input.callsToday)) : 0;
  const hasCap = typeof input.cap === "number" && Number.isFinite(input.cap) && input.cap >= 0;
  const cap = hasCap ? Math.trunc(input.cap as number) : null;
  const recommended = typeof input.recommended === "number" && Number.isFinite(input.recommended)
    ? Math.trunc(input.recommended)
    : null;

  const blocked = cap !== null && callsToday >= cap;
  const overRecommendation = !blocked && recommended !== null && callsToday >= recommended;

  return {
    callsToday,
    cap,
    recommended,
    state: blocked ? "at_cap" : overRecommendation ? "over_recommendation" : "normal",
    blocked,
    overRecommendation,
    remaining: cap === null ? null : Math.max(0, cap - callsToday),
  };
}

/** The one sentence a blocked call comes back with. */
export function dailyCapMessage(cap: number): string {
  return `You've hit your daily cap of ${cap} AI calls. ` +
    `Raise or remove it in settings, or it resets at midnight.`;
}

/**
 * The amber banner. Plain and non-scary on purpose: the agent has not done
 * anything wrong, and the only action offered is the one that actually helps.
 */
export function paceBannerText(numberCount: number): string {
  const n = Math.max(1, Math.trunc(numberCount) || 1);
  return `You're past the recommended daily pace for ${n} number${n === 1 ? "" : "s"}. ` +
    `Carriers may start marking this number 'Spam Likely' if it keeps this pace up. ` +
    `Adding another AI number raises the recommendation.`;
}
