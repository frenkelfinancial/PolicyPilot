// ============================================================
// ai-call-meter.test.ts — run with:  npm run test:ai   (Node 24, no deps)
//
// The daily AI-call meter, proved without a phone:
//   • the seven-day ramp (day boundaries, day 8+, several numbers at once, a
//     number that has never carried a call)
//   • the agent-local day window (Chicago vs UTC vs a DST changeover)
//   • the gate itself: at the cap, past the recommendation, no cap at all,
//     and the fact that inbound is not in the count the gate reads
//   • the idempotency contract behind "one warning event per agent per day"
//
// Every case here is arithmetic on a fixed `now`, so it runs the same in July
// and in January and on a machine set to Tokyo.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_DAILY_CALL_RECOMMENDATION,
  AI_DEFAULT_DAILY_CAP,
  AI_METER_DEFAULT_TZ,
  AI_RAMP_DAYS,
  AI_RAMP_SCHEDULE,
  addDays,
  dailyCapMessage,
  daysBetween,
  evaluateDailyPace,
  isValidTimezone,
  localDayKey,
  localDayWindow,
  localMidnightUtc,
  numberRampValue,
  paceBannerText,
  rampDayIndex,
  recommendedDailyCalls,
  resolveAgentTimezone,
} from "./ai-call-meter.ts";

const CHI = "America/Chicago";

// ============================================================
// 1. CONSTANTS — the shape the product decision was stated in
// ============================================================

test("the recommendation is 300/day/number and the ramp is the agreed seven days", () => {
  assert.equal(AI_DAILY_CALL_RECOMMENDATION, 300);
  assert.deepEqual(AI_RAMP_SCHEDULE, [30, 60, 100, 150, 200, 250, 300]);
  assert.equal(AI_RAMP_DAYS, 7);
  // The recommendation IS the default cap — a strong default, not a mandate.
  assert.equal(AI_DEFAULT_DAILY_CAP, AI_DAILY_CALL_RECOMMENDATION);
  assert.equal(AI_METER_DEFAULT_TZ, "America/Chicago");
});

// ============================================================
// 2. RAMP MATH
// ============================================================

const at = (localDate: string) => new Date(`${localDate}T18:00:00-05:00`); // mid-afternoon CDT

test("ramp: day 1 is the calendar day of first use, not 24h later", () => {
  const first = "2026-07-01T23:30:00-05:00"; // 11:30pm Chicago on the 1st
  assert.equal(rampDayIndex(first, at("2026-07-01"), CHI), 1);
  assert.equal(numberRampValue(first, at("2026-07-01"), CHI), 30);
  // 40 minutes later it is a NEW LOCAL DAY, so day 2 — even though barely any
  // time has passed. The ramp is about calendar days, which is what a carrier
  // sees.
  assert.equal(rampDayIndex(first, new Date("2026-07-02T00:10:00-05:00"), CHI), 2);
  assert.equal(numberRampValue(first, new Date("2026-07-02T00:10:00-05:00"), CHI), 60);
});

test("ramp: every day of the schedule lands on its stated value", () => {
  const first = "2026-07-01T09:00:00-05:00";
  const expected = [30, 60, 100, 150, 200, 250, 300];
  for (let d = 1; d <= 7; d++) {
    const day = String(d).padStart(2, "0");
    assert.equal(rampDayIndex(first, at(`2026-07-${day}`), CHI), d, `day index ${d}`);
    assert.equal(numberRampValue(first, at(`2026-07-${day}`), CHI), expected[d - 1], `day ${d} value`);
  }
});

test("ramp: day 8 and beyond is the full recommendation", () => {
  const first = "2026-07-01T09:00:00-05:00";
  assert.equal(rampDayIndex(first, at("2026-07-08"), CHI), 8);
  assert.equal(numberRampValue(first, at("2026-07-08"), CHI), 300);
  assert.equal(numberRampValue(first, at("2026-09-30"), CHI), 300);
  assert.equal(numberRampValue(first, at("2027-07-01"), CHI), 300);
});

test("ramp: a number that has NEVER carried an AI call is day 1, not day 0", () => {
  // The moment it carries one it IS day 1, so 30 is both the safe answer and
  // the true one. Answering 300 would hand a number bought this morning a full
  // day's volume.
  for (const empty of [null, undefined, ""]) {
    assert.equal(rampDayIndex(empty, at("2026-07-15"), CHI), 1);
    assert.equal(numberRampValue(empty, at("2026-07-15"), CHI), 30);
  }
  assert.equal(numberRampValue("not-a-date", at("2026-07-15"), CHI), 30);
});

test("ramp: a first-use stamp in the future clamps to day 1", () => {
  // Clock skew between the DB and the runtime must not produce day 0 or a
  // negative index into the schedule (which would be `undefined` calls).
  assert.equal(rampDayIndex("2026-08-01T09:00:00-05:00", at("2026-07-15"), CHI), 1);
  assert.equal(numberRampValue("2026-08-01T09:00:00-05:00", at("2026-07-15"), CHI), 30);
});

test("ramp: the schedule is read in the AGENT's zone, so it can differ by zone", () => {
  // First use at 00:30 UTC on the 2nd = 7:30pm Chicago on the 1st.
  const first = "2026-07-02T00:30:00Z";
  const now = new Date("2026-07-02T12:00:00Z");
  assert.equal(rampDayIndex(first, now, "UTC"), 1);       // same UTC day
  assert.equal(rampDayIndex(first, now, CHI), 2);         // next Chicago day
});

// ============================================================
// 3. THE RECOMMENDATION ACROSS A POOL
// ============================================================

test("recommendation: one mature number recommends 300", () => {
  const r = recommendedDailyCalls(
    [{ e164: "+12029981783", ai_first_used_at: "2026-06-01T09:00:00-05:00" }],
    at("2026-07-15"),
    CHI,
  );
  assert.equal(r.recommended, 300);
  assert.equal(r.numberCount, 1);
  assert.equal(r.ramping.length, 0);
  assert.equal(r.numbers[0].last4, "1783");
  assert.equal(r.numbers[0].neverUsed, false);
});

test("recommendation: numbers add up, each at its OWN ramp day", () => {
  const now = at("2026-07-15");
  const r = recommendedDailyCalls([
    { e164: "+12029981783", ai_first_used_at: "2026-06-01T09:00:00-05:00" }, // mature -> 300
    { e164: "+12026143091", ai_first_used_at: "2026-07-14T09:00:00-05:00" }, // day 2  ->  60
    { e164: "+15550001234", ai_first_used_at: null },                        // day 1  ->  30
  ], now, CHI);
  assert.equal(r.recommended, 390);
  assert.equal(r.numberCount, 3);
  assert.deepEqual(r.numbers.map((n) => n.recommended), [300, 60, 30]);
  assert.deepEqual(r.numbers.map((n) => n.day), [45, 2, 1]);
  // Only the two inside their first seven days get a ramp chip.
  assert.deepEqual(r.ramping.map((n) => n.last4), ["3091", "1234"]);
});

test("recommendation: NO active numbers is null, not zero", () => {
  // 0 and null differ. A recommendation of 0 would flag every call on an
  // account that cannot dial at all; null says there is no pool to advise on.
  for (const empty of [[], null, undefined]) {
    const r = recommendedDailyCalls(empty, at("2026-07-15"), CHI);
    assert.equal(r.recommended, null);
    assert.equal(r.numberCount, 0);
  }
});

test("recommendation: a number is never recommended above 300 by the ramp", () => {
  for (let d = 1; d <= AI_RAMP_DAYS; d++) {
    assert.ok(AI_RAMP_SCHEDULE[d - 1] <= AI_DAILY_CALL_RECOMMENDATION);
  }
});

// ============================================================
// 4. THE AGENT-LOCAL DAY
// ============================================================

test("day window: Chicago and UTC disagree, and the agent's zone wins", () => {
  // 02:00 UTC on 2026-07-15 is still 2026-07-14 in Chicago.
  const instant = new Date("2026-07-15T02:00:00Z");
  assert.equal(localDayKey(instant, CHI), "2026-07-14");
  assert.equal(localDayKey(instant, "UTC"), "2026-07-15");

  const chi = localDayWindow(instant, CHI);
  assert.equal(chi.dayKey, "2026-07-14");
  assert.equal(chi.startIso, "2026-07-14T05:00:00.000Z"); // CDT = UTC-5
  assert.equal(chi.endIso, "2026-07-15T05:00:00.000Z");

  const utc = localDayWindow(instant, "UTC");
  assert.equal(utc.startIso, "2026-07-15T00:00:00.000Z");
  assert.equal(utc.endIso, "2026-07-16T00:00:00.000Z");
});

test("day window: the end is EXCLUSIVE, so no call lands in two days", () => {
  const w = localDayWindow(new Date("2026-07-14T12:00:00Z"), CHI);
  const next = localDayWindow(new Date(w.endIso), CHI);
  assert.equal(next.dayKey, "2026-07-15");
  assert.equal(next.startIso, w.endIso);
});

test("day window: survives a DST changeover in both directions", () => {
  // Spring forward: 2026-03-08 in Chicago is 23 hours long.
  const spring = localDayWindow(new Date("2026-03-08T18:00:00Z"), CHI);
  assert.equal(spring.dayKey, "2026-03-08");
  assert.equal(spring.startIso, "2026-03-08T06:00:00.000Z"); // still CST at midnight
  assert.equal(spring.endIso, "2026-03-09T05:00:00.000Z");   // CDT by the next midnight
  assert.equal(
    (Date.parse(spring.endIso) - Date.parse(spring.startIso)) / 3600000, 23,
  );

  // Fall back: 2026-11-01 is 25 hours long.
  const fall = localDayWindow(new Date("2026-11-01T18:00:00Z"), CHI);
  assert.equal(fall.dayKey, "2026-11-01");
  assert.equal(
    (Date.parse(fall.endIso) - Date.parse(fall.startIso)) / 3600000, 25,
  );
});

test("day window: a zone with a half-hour offset still lands on midnight", () => {
  const w = localDayWindow(new Date("2026-07-15T09:00:00Z"), "Asia/Kolkata"); // +05:30
  assert.equal(w.dayKey, "2026-07-15");
  assert.equal(w.startIso, "2026-07-14T18:30:00.000Z");
  assert.equal(w.endIso, "2026-07-15T18:30:00.000Z");
});

test("localMidnightUtc / addDays / daysBetween are plain calendar arithmetic", () => {
  assert.equal(localMidnightUtc("2026-07-14", CHI).toISOString(), "2026-07-14T05:00:00.000Z");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);   // 2026 is not a leap year
  assert.equal(daysBetween("2026-03-08", "2026-03-09"), 1);   // DST does not change a day count
  assert.equal(daysBetween("2026-07-15", "2026-07-15"), 0);
});

// ============================================================
// 5. TIMEZONE RESOLUTION
// ============================================================

test("timezone: a stored zone wins, anything else falls back to Chicago", () => {
  assert.equal(resolveAgentTimezone({ timezone: "America/Los_Angeles" }), "America/Los_Angeles");
  assert.equal(resolveAgentTimezone({ timezone: "  America/Denver  " }), "America/Denver");
  assert.equal(resolveAgentTimezone({ timezone: null }), CHI);
  assert.equal(resolveAgentTimezone({ timezone: "" }), CHI);
  assert.equal(resolveAgentTimezone({ timezone: "Mars/Olympus_Mons" }), CHI);
  assert.equal(resolveAgentTimezone({ timezone: 42 as unknown as string }), CHI);
  assert.equal(resolveAgentTimezone(null), CHI);
  assert.equal(resolveAgentTimezone(undefined), CHI);
});

test("timezone: an unusable zone never reaches Intl and blows up the window", () => {
  assert.equal(isValidTimezone("Not/AZone"), false);
  const w = localDayWindow(new Date("2026-07-15T02:00:00Z"), "Not/AZone");
  assert.equal(w.timezone, CHI);
  assert.equal(w.dayKey, "2026-07-14");
});

// ============================================================
// 6. THE GATE
// ============================================================

test("gate: under both limits is a plain allow", () => {
  const v = evaluateDailyPace({ callsToday: 120, cap: 300, recommended: 300 });
  assert.equal(v.state, "normal");
  assert.equal(v.blocked, false);
  assert.equal(v.overRecommendation, false);
  assert.equal(v.remaining, 180);
});

test("gate: AT the cap blocks — the agent chose that number", () => {
  const v = evaluateDailyPace({ callsToday: 300, cap: 300, recommended: 300 });
  assert.equal(v.state, "at_cap");
  assert.equal(v.blocked, true);
  assert.equal(v.remaining, 0);
  // Blocked calls leave no "you were warned" record: the call never happened.
  assert.equal(v.overRecommendation, false);
});

test("gate: past the RECOMMENDATION but under the cap ALLOWS and warns", () => {
  // This is the whole product decision. 500 calls on one number is allowed.
  const v = evaluateDailyPace({ callsToday: 420, cap: 500, recommended: 300 });
  assert.equal(v.blocked, false, "the recommendation must never block");
  assert.equal(v.overRecommendation, true);
  assert.equal(v.state, "over_recommendation");
  assert.equal(v.remaining, 80);
});

test("gate: a NULL cap means no cap, at any volume", () => {
  const v = evaluateDailyPace({ callsToday: 9999, cap: null, recommended: 300 });
  assert.equal(v.blocked, false);
  assert.equal(v.cap, null);
  assert.equal(v.remaining, null);
  assert.equal(v.overRecommendation, true); // still says so, still dials
  assert.equal(evaluateDailyPace({ callsToday: 9999, recommended: 300 }).blocked, false);
});

test("gate: a cap ABOVE the recommendation is honoured, warning and all", () => {
  // 300 recommended, 500 cap: warned from 300, refused only at 500.
  assert.equal(evaluateDailyPace({ callsToday: 299, cap: 500, recommended: 300 }).state, "normal");
  assert.equal(evaluateDailyPace({ callsToday: 300, cap: 500, recommended: 300 }).state, "over_recommendation");
  assert.equal(evaluateDailyPace({ callsToday: 499, cap: 500, recommended: 300 }).blocked, false);
  assert.equal(evaluateDailyPace({ callsToday: 500, cap: 500, recommended: 300 }).blocked, true);
});

test("gate: a cap of 0 is a real setting — AI calling paused", () => {
  const v = evaluateDailyPace({ callsToday: 0, cap: 0, recommended: 300 });
  assert.equal(v.blocked, true);
  assert.equal(v.remaining, 0);
});

test("gate: no recommendation (no active numbers) never reads as over pace", () => {
  const v = evaluateDailyPace({ callsToday: 50, cap: null, recommended: null });
  assert.equal(v.overRecommendation, false);
  assert.equal(v.state, "normal");
});

test("gate: junk counts and caps degrade to safe values, never to a block", () => {
  assert.equal(evaluateDailyPace({ callsToday: NaN, cap: 300, recommended: 300 }).callsToday, 0);
  assert.equal(evaluateDailyPace({ callsToday: -5, cap: 300, recommended: 300 }).callsToday, 0);
  assert.equal(evaluateDailyPace({ callsToday: 10, cap: -1, recommended: 300 }).cap, null);
  assert.equal(evaluateDailyPace({ callsToday: 10, cap: Infinity, recommended: 300 }).cap, null);
});

test("gate: the ramp is what a brand-new agent is actually held to", () => {
  // Day 1, one number: recommended 30. The 31st call warns; nothing blocks it
  // until their own 300 default cap.
  const rec = recommendedDailyCalls(
    [{ e164: "+15550001234", ai_first_used_at: "2026-07-15T09:00:00-05:00" }],
    at("2026-07-15"),
    CHI,
  );
  assert.equal(rec.recommended, 30);
  assert.equal(evaluateDailyPace({ callsToday: 29, cap: 300, recommended: rec.recommended }).state, "normal");
  assert.equal(evaluateDailyPace({ callsToday: 30, cap: 300, recommended: rec.recommended }).state, "over_recommendation");
  assert.equal(evaluateDailyPace({ callsToday: 30, cap: 300, recommended: rec.recommended }).blocked, false);
});

// ============================================================
// 7. INBOUND IS NOT IN THE COUNT
// ============================================================

test("the day count is OUTBOUND only — a consumer calling us is never metered", () => {
  // The gate itself takes a number; the direction filter lives in the query in
  // ai-call-start. This pins the shape of that count so the two cannot drift:
  // given a day's rows, only the outbound ones may reach evaluateDailyPace.
  const rows = [
    { direction: "outbound" }, { direction: "outbound" }, { direction: "outbound" },
    { direction: "inbound" }, { direction: "inbound" },
  ];
  const counted = rows.filter((r) => r.direction === "outbound").length;
  assert.equal(counted, 3);
  const v = evaluateDailyPace({ callsToday: counted, cap: 3, recommended: 300 });
  assert.equal(v.blocked, true);
  // With the two inbound calls wrongly included it would be 5 — still blocked
  // here, but on an account at 299 outbound it is the difference between
  // dialing and not.
  assert.equal(evaluateDailyPace({ callsToday: 299, cap: 300, recommended: 300 }).blocked, false);
  assert.equal(evaluateDailyPace({ callsToday: 301, cap: 300, recommended: 300 }).blocked, true);
});

// ============================================================
// 8. THE WARNING EVENT IS WRITTEN ONCE PER AGENT PER DAY
// ============================================================

test("one warning event per agent per local day, however many calls follow", () => {
  // Mirrors the ON CONFLICT (agent_id, local_day) DO NOTHING write in
  // ai-call-start: the KEY does the remembering, not the caller.
  const table = new Map<string, { calls_today: number }>();
  const write = (agentId: string, dayKey: string, callsToday: number) => {
    const key = `${agentId}|${dayKey}`;
    if (table.has(key)) return false;
    table.set(key, { calls_today: callsToday });
    return true;
  };

  const agent = "a1";
  const day = "2026-07-15";
  let written = 0;
  for (let calls = 300; calls < 500; calls++) {
    const v = evaluateDailyPace({ callsToday: calls, cap: 500, recommended: 300 });
    if (v.overRecommendation && write(agent, day, calls)) written++;
  }
  assert.equal(written, 1, "exactly one row for the day");
  assert.equal(table.get(`${agent}|${day}`)!.calls_today, 300,
    "the row records the count at the FIRST warning, not the day's total");

  // A new local day is a new row.
  assert.equal(write(agent, "2026-07-16", 300), true);
  // A different agent on the same day is a different row.
  assert.equal(write("a2", day, 300), true);
  assert.equal(table.size, 3);
});

test("nothing is written for a call the cap refused", () => {
  const v = evaluateDailyPace({ callsToday: 500, cap: 500, recommended: 300 });
  assert.equal(v.blocked, true);
  assert.equal(v.overRecommendation, false, "a call that never happened leaves no warning");
});

// ============================================================
// 9. COPY
// ============================================================

test("the blocked message names the cap, where to change it, and when it lifts", () => {
  const msg = dailyCapMessage(300);
  assert.equal(msg,
    "You've hit your daily cap of 300 AI calls. Raise or remove it in settings, or it resets at midnight.");
  assert.match(dailyCapMessage(500), /daily cap of 500 AI calls/);
});

test("the amber banner is informational and offers the one action that helps", () => {
  const one = paceBannerText(1);
  assert.match(one, /past the recommended daily pace for 1 number\./);
  assert.match(one, /Spam Likely/);
  assert.match(one, /Adding another AI number raises the recommendation\./);
  assert.match(paceBannerText(3), /for 3 numbers\./);
  // Never scolds, never threatens a block.
  for (const n of [1, 2, 5]) {
    assert.doesNotMatch(paceBannerText(n), /block|stopped|violation|suspend/i);
  }
});
