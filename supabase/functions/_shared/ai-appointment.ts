// ============================================================
// ai-appointment.ts
// Turning "Tuesday at two" into an instant, in the LEAD's timezone.
//
// Dependency-free (no supabase, no Deno globals, no date library) so it runs
// under BOTH `node --test` and the Deno edge runtime — same arrangement as
// ai-call-billing.ts and ai-call-outcome.ts. `now` and `timeZone` are always
// passed in, never read from the environment, so every test is deterministic
// and the SERVER's clock and zone are never accidentally authoritative over
// the lead's.
//
// ---- The one rule ---------------------------------------------------------
//
// A wrong appointment time is worse than no appointment. The agent drives to a
// house, or rings at 9am a lead who said 9pm, and the lead's read is that the
// agency is disorganised. So this parser is deliberately narrow: it recognises
// the shapes a voice assistant actually produces, refuses anything it does not
// recognise, and returns a `reason` the assistant can read back to the lead to
// re-ask. Guessing is the failure mode being avoided.
//
// Ambiguity that CANNOT be refused (a bare "at two" has no am/pm) is resolved
// by a documented business-hours rule and flagged `approximate`, so the caller
// can have the assistant confirm the concrete time out loud before booking.
// ============================================================

export interface ParseTimeOk {
  ok: true;
  /** The absolute instant. */
  at: Date;
  /** Wall-clock parts as they will read to the LEAD, for confirming out loud. */
  spoken: string;
  /** True when an am/pm or a vague period ("morning") had to be inferred. */
  approximate: boolean;
}

export interface ParseTimeErr {
  ok: false;
  reason: string;
}

export type ParseTimeResult = ParseTimeOk | ParseTimeErr;

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};

/**
 * Vague periods, and the hour each resolves to. These are DEFAULTS the
 * assistant is required to confirm — every one of them comes back
 * `approximate: true`.
 */
const PERIODS: Record<string, number> = {
  morning: 9,
  afternoon: 14,
  evening: 18,
  tonight: 18,
  night: 19,
  noon: 12,
  midday: 12,
  midnight: 0,
  lunchtime: 12,
};

/** How far ahead a booking may land. Beyond this, the parse went wrong. */
export const MAX_DAYS_AHEAD = 120;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The wall-clock parts of `instant` as rendered in `timeZone`.
 * Uses Intl rather than a table of offsets so DST is the platform's problem.
 */
export function zonedParts(instant: Date, timeZone: string): {
  year: number; month: number; day: number; hour: number; minute: number; weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short", hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) parts[p.type] = p.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year:   Number(parts.year),
    // `hour12: false` renders midnight as 24 in some ICU versions.
    month:  Number(parts.month) - 1,
    day:    Number(parts.day),
    hour:   Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

/**
 * The instant at which `timeZone`'s wall clock reads the given local time.
 *
 * Two passes: guess that local == UTC, measure how far off the guess renders,
 * correct, then measure again (the second pass matters when the correction
 * crosses a DST boundary). Ambiguous times in a fall-back hour resolve to one
 * of the two valid instants — acceptable, and not something a 2pm appointment
 * ever hits.
 */
export function zonedTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): Date {
  const target = Date.UTC(year, month, day, hour, minute, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const rendered = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, 0, 0);
    const drift = rendered - target;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/**
 * How the resolved time will sound to the lead. This exact string is what the
 * assistant repeats back and what the confirmation SMS quotes, so the two can
 * never describe different appointments.
 */
export function speakTime(instant: Date, timeZone: string): string {
  const d = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "long", month: "long", day: "numeric",
  }).format(instant);
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(instant).replace(/\s?([AP])M/i, (_m, p) => ` ${String(p).toLowerCase()}m`);
  return `${d} at ${t}`;
}

/** Short zone label ("CDT") for the SMS. */
export function zoneLabel(instant: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(instant);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
}

interface TimeOfDay { hour: number; minute: number; approximate: boolean }

/**
 * Spelled-out numbers, because PEOPLE SAY WORDS and a speech-to-text engine
 * writes down what they said.
 *
 * This is not a nicety. On the first live booking the caller said "tomorrow at
 * ten", the assistant passed `"tomorrow at ten in the morning"`, no digit
 * matched anything below, and the parser fell through to the vague-period
 * default — booking **9am for a caller who said ten**. It then said nine back
 * to them, twice. A second attempt with `"tomorrow at ten AM"` failed to parse
 * at all. Both are in ai_call_events (2026-07-30 20:45–20:46).
 *
 * So word-numbers are normalised to digits BEFORE any of the digit patterns
 * run, which means every rule below — the meridiem, the business-hours
 * default, the period disambiguation — applies to "ten" exactly as it applies
 * to "10", with no second code path to keep in step.
 */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
  forty: 40, fifty: 50,
};

/**
 * Rewrite spoken numbers into digits: "ten thirty" -> "10:30",
 * "quarter past ten" -> "10:15", "half past six" -> "6:30", "ten" -> "10".
 *
 * Deliberately narrow. It only ever rewrites a standalone number WORD, so
 * "someone", "phone" and "fifteen thousand" are untouched, and it runs on the
 * `datetime_text` argument alone — never on notes or a summary.
 */
export function normalizeSpokenNumbers(text: string): string {
  let t = ` ${text.toLowerCase()} `;

  const hourWords = Object.keys(NUMBER_WORDS).filter((w) => NUMBER_WORDS[w] <= 12).join("|");
  const minuteWords = "fifteen|thirty|forty ?five|forty-five|twenty|ten|five|oh five|o'? ?clock";

  // "quarter past ten" / "half past six" / "quarter to five"
  t = t.replace(new RegExp(`\\b(quarter|half)\\s+past\\s+(${hourWords}|\\d{1,2})\\b`, "g"),
    (_m, frac, hr) => {
      const h = /^\d+$/.test(hr) ? Number(hr) : NUMBER_WORDS[hr];
      return ` ${h}:${frac === "half" ? "30" : "15"} `;
    });
  t = t.replace(new RegExp(`\\b(quarter|half)\\s+to\\s+(${hourWords}|\\d{1,2})\\b`, "g"),
    (_m, frac, hr) => {
      const h = /^\d+$/.test(hr) ? Number(hr) : NUMBER_WORDS[hr];
      const prev = h === 1 ? 12 : h - 1;
      return ` ${prev}:${frac === "half" ? "30" : "45"} `;
    });

  // "ten o'clock" -> "10"
  t = t.replace(new RegExp(`\\b(${hourWords})\\s+o'? ?clock\\b`, "g"),
    (_m, hr) => ` ${NUMBER_WORDS[hr]} `);
  t = t.replace(/\b(\d{1,2})\s+o'? ?clock\b/g, " $1 ");

  // "ten thirty" / "ten forty five" -> "10:30" / "10:45"
  t = t.replace(new RegExp(`\\b(${hourWords})\\s+(${minuteWords})\\b`, "g"), (m, hr, min) => {
    const h = NUMBER_WORDS[hr];
    const key = String(min).replace(/-/g, " ").replace(/\s+/g, " ").trim();
    const mins = key === "forty five" ? 45 : (NUMBER_WORDS[key] ?? null);
    if (mins == null || mins > 59) return m;
    return ` ${h}:${String(mins).padStart(2, "0")} `;
  });

  // A bare hour word last, so the compound forms above win.
  t = t.replace(new RegExp(`\\b(${hourWords})\\b`, "g"), (_m, hr) => ` ${NUMBER_WORDS[hr]} `);

  return t.replace(/\s+/g, " ").trim();
}

/**
 * Find a time of day in the phrase.
 *
 * The bare-hour rule ("at two" with no am/pm): 1-6 -> PM, 7-11 -> AM, 12 ->
 * noon. That is where a life-insurance appointment actually lands; "two in the
 * morning" is a typo, not a booking. Any inference sets `approximate`.
 */
export function parseTimeOfDay(text: string): TimeOfDay | null {
  // Words to digits FIRST, so every rule below sees "10" whether the caller
  // said "ten" or "10". See normalizeSpokenNumbers for why this is load-bearing.
  const t = normalizeSpokenNumbers(text);

  // "in the morning" / "this afternoon" / "tonight" is a MERIDIEM the caller
  // actually said, and it beats any inference. It is resolved once, here, and
  // applied by every branch below — the h:mm branch used to skip it, which made
  // "two thirty in the afternoon" come out as an approximate guess rather than
  // the unambiguous 2:30pm it plainly is.
  const spokenAm = /\bmorning\b/.test(t);
  const spokenPm = /\b(afternoon|evening|tonight)\b/.test(t);

  /** Apply the business-hours rule to an hour with no meridiem of any kind. */
  const infer = (hour: number, minute: number): TimeOfDay | null => {
    if (hour > 23) return null;
    if (hour >= 1 && hour <= 6) return { hour: hour + 12, minute, approximate: true }; // 1-6 -> PM
    if (hour === 12) return { hour: 12, minute, approximate: true };
    if (hour > 12) return { hour, minute, approximate: false };                        // 24-hour, unambiguous
    return { hour, minute, approximate: true };                                        // 7-11 -> AM
  };

  /** Apply a spoken period ("in the morning") to a 12-hour clock reading. */
  const applySpoken = (hour: number, minute: number): TimeOfDay | null => {
    if (spokenAm && hour <= 12) return { hour: hour === 12 ? 0 : hour, minute, approximate: false };
    if (spokenPm && hour < 12)  return { hour: hour + 12, minute, approximate: false };
    if (spokenPm && hour === 12) return { hour: 12, minute, approximate: false };
    return null;
  };

  // 1. h:mm, with an explicit meridiem, a spoken period, or neither.
  const hm = t.match(/\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/);
  if (hm) {
    let hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (minute > 59) return null;
    const mer = hm[3]?.replace(/\./g, "");
    if (mer) {
      if (mer === "pm" && hour < 12) hour += 12;
      else if (mer === "am" && hour === 12) hour = 0;
      if (hour > 23) return null;
      return { hour, minute, approximate: false };
    }
    return applySpoken(hour, minute) ?? infer(hour, minute);
  }

  // 2. A bare hour with a meridiem: "2pm", "at 10 a.m."
  const hMer = t.match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)/);
  if (hMer) {
    let hour = Number(hMer[1]);
    if (hour > 12) return null;
    const mer = hMer[2].replace(/\./g, "");
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    return { hour, minute: 0, approximate: false };
  }

  // 3. A standalone hour.
  //
  // DATE NUMBERS ARE REMOVED FIRST. Without that, "August 5 in the morning"
  // reads the 5 as five o'clock. And the anchor word ("at", "around") cannot be
  // required: "nine o'clock in the morning" normalises to "9 in the morning",
  // which has no anchor at all — requiring one sent it to the vague-period
  // branch, where "eleven o'clock in the morning" would have booked NINE.
  const monthNames = Object.keys(MONTHS).join("|");
  const withoutDates = t
    .replace(new RegExp(`\\b(?:${monthNames})\\b\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?`, "g"), " ")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${monthNames})\\b`, "g"), " ")
    .replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/g, " ");

  const anchored = withoutDates.match(/\b(?:at|around|about)\s+(\d{1,2})\b(?!\s*[:.]\d)/);
  const bare = anchored ?? withoutDates.match(/\b(\d{1,2})\b(?!\s*[:.]\d)/);
  if (bare) {
    const hour = Number(bare[1]);
    if (hour > 23) return null;
    return applySpoken(hour, 0) ?? infer(hour, 0);
  }

  // 4. A named period on its own ("Tuesday morning"). A DEFAULT, always
  //    flagged approximate so the assistant confirms it out loud.
  for (const [word, hour] of Object.entries(PERIODS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      return { hour, minute: 0, approximate: !(word === "noon" || word === "midnight") };
    }
  }

  return null;
}

/**
 * Parse what the lead agreed to into an instant.
 *
 * @param text     the phrase, as the assistant heard it ("Tuesday at 2:30")
 * @param timeZone the LEAD's IANA zone
 * @param now      the current instant (injected; never read from the clock here)
 */
export function parseAppointmentTime(
  text: unknown, timeZone: string, now: Date,
): ParseTimeResult {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, reason: "No time was given." };
  }
  let tz = (timeZone || "").trim();
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = ""; }
  if (!tz) return { ok: false, reason: "No usable timezone for this lead." };

  const raw = text.trim();
  // Same normalisation the time-of-day parser uses, so a spoken date like
  // "the fifth of August" is read the same way as "the 5th of August".
  const t = normalizeSpokenNumbers(raw);
  const today = zonedParts(now, tz);

  const tod = parseTimeOfDay(t);
  if (!tod) {
    return {
      ok: false,
      reason: `Could not work out a time of day from "${raw}". Ask for a day and a clock time, ` +
        `like "Tuesday at 2 in the afternoon".`,
    };
  }

  // ---- The day ------------------------------------------------------------
  let year = today.year, month = today.month, day = today.day;
  let dayFound = false;

  // "july 31" / "31 july"
  const monthName = t.match(
    new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\b\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?`),
  ) || t.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${Object.keys(MONTHS).join("|")})\\b`),
  );
  if (monthName) {
    const a = monthName[1], b = monthName[2];
    const m = MONTHS[a] !== undefined ? MONTHS[a] : MONTHS[b];
    const dnum = MONTHS[a] !== undefined ? Number(b) : Number(a);
    if (m !== undefined && dnum >= 1 && dnum <= 31) {
      month = m; day = dnum; dayFound = true;
      // A month already past this year means next year — "January 5th" said in
      // December is not eleven months ago.
      if (month < today.month || (month === today.month && day < today.day)) year = today.year + 1;
    }
  }

  // "7/31" or "7-31"
  if (!dayFound) {
    const numeric = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (numeric) {
      const m = Number(numeric[1]) - 1, dnum = Number(numeric[2]);
      if (m >= 0 && m <= 11 && dnum >= 1 && dnum <= 31) {
        month = m; day = dnum; dayFound = true;
        if (numeric[3]) {
          const y = Number(numeric[3]);
          year = y < 100 ? 2000 + y : y;
        } else if (month < today.month || (month === today.month && day < today.day)) {
          year = today.year + 1;
        }
      }
    }
  }

  if (!dayFound && /\btomorrow\b/.test(t)) {
    const d = new Date(Date.UTC(today.year, today.month, today.day + 1));
    year = d.getUTCFullYear(); month = d.getUTCMonth(); day = d.getUTCDate();
    dayFound = true;
  }

  if (!dayFound && /\b(today|this afternoon|this evening|tonight)\b/.test(t)) {
    dayFound = true; // already initialised to today
  }

  if (!dayFound) {
    for (const [word, dow] of Object.entries(WEEKDAYS)) {
      if (!new RegExp(`\\b${word}\\b`).test(t)) continue;
      // "next Tuesday" means the Tuesday of next week, not the coming one.
      const wantsNextWeek = new RegExp(`\\bnext\\s+${word}\\b`).test(t);
      let delta = (dow - today.weekday + 7) % 7;
      if (delta === 0) delta = 7;             // "Tuesday" said ON Tuesday means the next one
      if (wantsNextWeek && delta < 7) delta += 7;
      const d = new Date(Date.UTC(today.year, today.month, today.day + delta));
      year = d.getUTCFullYear(); month = d.getUTCMonth(); day = d.getUTCDate();
      dayFound = true;
      break;
    }
  }

  let at = zonedTimeToUtc(year, month, day, tod.hour, tod.minute, tz);

  // No day at all ("at 3 o'clock") means today if that is still ahead, else
  // tomorrow. Rolling a bare time forward is safe; rolling a NAMED day forward
  // is not, which is why only this branch does it.
  if (!dayFound && at.getTime() <= now.getTime()) {
    const d = new Date(Date.UTC(year, month, day + 1));
    at = zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), tod.hour, tod.minute, tz);
  }

  if (at.getTime() <= now.getTime()) {
    return {
      ok: false,
      reason: `"${raw}" resolves to a time that has already passed. Ask for a day and time in the future.`,
    };
  }

  const daysOut = (at.getTime() - now.getTime()) / 86400000;
  if (daysOut > MAX_DAYS_AHEAD) {
    return {
      ok: false,
      reason: `"${raw}" resolves to more than ${MAX_DAYS_AHEAD} days away, which is almost certainly a ` +
        `misheard date. Confirm the day with the caller.`,
    };
  }

  return { ok: true, at, spoken: speakTime(at, tz), approximate: tod.approximate };
}

/**
 * The confirmation SMS body.
 *
 * Kept here, next to the parser, so the time in the text is formatted from the
 * same instant by the same code — a template built somewhere else is how a
 * lead gets told 3pm for a 2pm appointment.
 *
 * "Reply STOP to opt out" is not decoration: this is an A2P message on a live
 * 10DLC campaign and every send carries the opt-out line.
 */
export function buildConfirmSms(opts: {
  firstName?: string | null;
  aiName?: string | null;
  companyName?: string | null;
  at: Date;
  timeZone: string;
}): string {
  const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");
  const first = clean(opts.firstName);
  const who = clean(opts.aiName) || "the assistant";
  const company = clean(opts.companyName);
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: opts.timeZone, weekday: "long", month: "long", day: "numeric",
  }).format(opts.at);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: opts.timeZone, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(opts.at);
  const tz = zoneLabel(opts.at, opts.timeZone);

  const hi = first ? `Hi ${first}, ` : "Hi, ";
  const withCo = company ? ` with ${company}` : "";
  return `${hi}this is ${who}${withCo} — you're confirmed for ${when} at ${time}${tz ? ` ${tz}` : ""}. ` +
    `Reply STOP to opt out.`;
}
