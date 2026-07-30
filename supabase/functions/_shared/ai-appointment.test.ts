// ============================================================
// ai-appointment.test.ts — run with:  npm run test:ai   (Node 24, no deps)
//
// Every case pins a real instant and a real IANA zone. `now` is injected, so
// these assertions do not rot and do not depend on the machine's clock or the
// server's zone — which is the whole point: the appointment belongs to the
// LEAD's wall clock, not to ours.
//
// Reference instant used throughout:
//   2026-07-30T18:00:00Z  =  Thursday 30 July 2026, 1:00 pm America/Chicago
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DAYS_AHEAD,
  buildConfirmSms,
  parseAppointmentTime,
  parseTimeOfDay,
  speakTime,
  zonedParts,
  zonedTimeToUtc,
} from "./ai-appointment.ts";

const NOW = new Date("2026-07-30T18:00:00Z"); // Thu 1pm America/Chicago
const CHI = "America/Chicago";
const NYC = "America/New_York";
const LAX = "America/Los_Angeles";

// ---- zone plumbing ------------------------------------------------------

test("zonedParts: reads the LEAD's wall clock, not the server's", () => {
  const chi = zonedParts(NOW, CHI);
  assert.equal(chi.hour, 13);
  assert.equal(chi.day, 30);
  assert.equal(chi.weekday, 4, "Thursday");

  const la = zonedParts(NOW, LAX);
  assert.equal(la.hour, 11);
});

test("zonedTimeToUtc: round-trips through the zone", () => {
  const at = zonedTimeToUtc(2026, 7, 4, 14, 30, CHI); // 4 Aug 2026, 2:30pm CDT
  assert.equal(at.toISOString(), "2026-08-04T19:30:00.000Z");
  const back = zonedParts(at, CHI);
  assert.equal(back.hour, 14);
  assert.equal(back.minute, 30);
});

test("zonedTimeToUtc: 2pm is 2pm on both sides of a DST change", () => {
  // CDT (UTC-5) in August, CST (UTC-6) in December. Same wall clock, different
  // offsets — the whole reason this is not `new Date(y,m,d,h)`.
  assert.equal(zonedTimeToUtc(2026, 7, 4, 14, 0, CHI).toISOString(), "2026-08-04T19:00:00.000Z");
  assert.equal(zonedTimeToUtc(2026, 11, 4, 14, 0, CHI).toISOString(), "2026-12-04T20:00:00.000Z");
});

// ---- parseTimeOfDay -----------------------------------------------------

test("parseTimeOfDay: explicit meridiem is exact, never approximate", () => {
  assert.deepEqual(parseTimeOfDay("2pm"), { hour: 14, minute: 0, approximate: false });
  assert.deepEqual(parseTimeOfDay("at 10 a.m."), { hour: 10, minute: 0, approximate: false });
  assert.deepEqual(parseTimeOfDay("2:30 pm"), { hour: 14, minute: 30, approximate: false });
  assert.deepEqual(parseTimeOfDay("12:15 am"), { hour: 0, minute: 15, approximate: false });
});

test("parseTimeOfDay: a bare hour uses the business-hours rule and says so", () => {
  assert.deepEqual(parseTimeOfDay("at 2"), { hour: 14, minute: 0, approximate: true });
  assert.deepEqual(parseTimeOfDay("at 10"), { hour: 10, minute: 0, approximate: true });
  assert.deepEqual(parseTimeOfDay("at 12"), { hour: 12, minute: 0, approximate: true });
});

test("parseTimeOfDay: the phrase disambiguates a bare hour when it can", () => {
  assert.deepEqual(parseTimeOfDay("at 7 in the evening"), { hour: 19, minute: 0, approximate: false });
  assert.deepEqual(parseTimeOfDay("at 8 in the morning"), { hour: 8, minute: 0, approximate: false });
  assert.deepEqual(parseTimeOfDay("at 7 tonight"), { hour: 19, minute: 0, approximate: false });
});

test("parseTimeOfDay: vague periods resolve to a default and are flagged", () => {
  assert.deepEqual(parseTimeOfDay("tuesday morning"), { hour: 9, minute: 0, approximate: true });
  assert.deepEqual(parseTimeOfDay("in the afternoon"), { hour: 14, minute: 0, approximate: true });
  assert.deepEqual(parseTimeOfDay("at noon"), { hour: 12, minute: 0, approximate: false });
});

test("parseTimeOfDay: no time at all is null, not a guess", () => {
  assert.equal(parseTimeOfDay("sometime next week"), null);
  assert.equal(parseTimeOfDay("whenever suits you"), null);
});

// ---- parseAppointmentTime: the happy paths ------------------------------

const ok = (r: ReturnType<typeof parseAppointmentTime>) => {
  assert.equal(r.ok, true, r.ok ? "" : (r as { reason: string }).reason);
  return r as Extract<typeof r, { ok: true }>;
};

test("parseAppointmentTime: 'tomorrow at 2pm' in the lead's zone", () => {
  const r = ok(parseAppointmentTime("tomorrow at 2pm", CHI, NOW));
  assert.equal(r.at.toISOString(), "2026-07-31T19:00:00.000Z"); // Fri 2pm CDT
  assert.equal(r.approximate, false);
  assert.equal(r.spoken, "Friday, July 31 at 2:00 pm");
});

test("parseAppointmentTime: the SAME phrase lands on different instants in different zones", () => {
  const chi = ok(parseAppointmentTime("tomorrow at 2pm", CHI, NOW));
  const nyc = ok(parseAppointmentTime("tomorrow at 2pm", NYC, NOW));
  const lax = ok(parseAppointmentTime("tomorrow at 2pm", LAX, NOW));
  assert.equal(nyc.at.toISOString(), "2026-07-31T18:00:00.000Z");
  assert.equal(chi.at.toISOString(), "2026-07-31T19:00:00.000Z");
  assert.equal(lax.at.toISOString(), "2026-07-31T21:00:00.000Z");
});

test("parseAppointmentTime: a weekday name means the NEXT one", () => {
  // NOW is Thursday. "Tuesday" is 5 days out.
  const r = ok(parseAppointmentTime("Tuesday at 10am", CHI, NOW));
  assert.equal(r.at.toISOString(), "2026-08-04T15:00:00.000Z");
  assert.equal(zonedParts(r.at, CHI).weekday, 2);
});

test("parseAppointmentTime: a weekday said ON that weekday means next week, never today", () => {
  // NOW is Thursday 1pm. "Thursday at 4" must not book 3 hours from now.
  const r = ok(parseAppointmentTime("Thursday at 4pm", CHI, NOW));
  assert.equal(r.at.toISOString(), "2026-08-06T21:00:00.000Z");
});

test("parseAppointmentTime: 'next Tuesday' is a week later than 'Tuesday'", () => {
  const plain = ok(parseAppointmentTime("Tuesday at 10am", CHI, NOW));
  const next  = ok(parseAppointmentTime("next Tuesday at 10am", CHI, NOW));
  assert.equal((next.at.getTime() - plain.at.getTime()) / 86400000, 7);
});

test("parseAppointmentTime: explicit dates, named and numeric", () => {
  assert.equal(ok(parseAppointmentTime("August 5th at 3pm", CHI, NOW)).at.toISOString(), "2026-08-05T20:00:00.000Z");
  assert.equal(ok(parseAppointmentTime("8/5 at 3pm", CHI, NOW)).at.toISOString(), "2026-08-05T20:00:00.000Z");
  assert.equal(ok(parseAppointmentTime("the 5th of August at 3pm", CHI, NOW)).at.toISOString(), "2026-08-05T20:00:00.000Z");
});

test("parseAppointmentTime: a month already past rolls to next year", () => {
  // Said in December, "January 6th" is three weeks away, not eleven months ago.
  const inDecember = new Date("2026-12-20T18:00:00Z");
  const r = ok(parseAppointmentTime("January 6th at 10am", CHI, inDecember));
  assert.equal(zonedParts(r.at, CHI).year, 2027);
  assert.equal(r.at.toISOString(), "2027-01-06T16:00:00.000Z"); // 10am CST
});

test("parseAppointmentTime: the year-roll still obeys the sanity horizon", () => {
  // Said in JULY, "January 6th" would be ~160 days out. That is far likelier to
  // be a misheard date than a real booking, and the horizon must win over the
  // year-roll — otherwise a mishearing quietly books half a year away.
  const r = parseAppointmentTime("January 6th at 10am", CHI, NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, new RegExp(String(MAX_DAYS_AHEAD)));
});

test("parseAppointmentTime: 'tomorrow morning' books 9am and flags itself approximate", () => {
  const r = ok(parseAppointmentTime("tomorrow morning", CHI, NOW));
  assert.equal(zonedParts(r.at, CHI).hour, 9);
  assert.equal(r.approximate, true, "the assistant must confirm this one out loud");
});

test("parseAppointmentTime: a bare time with no day rolls forward when today has passed", () => {
  // NOW is 1pm Chicago; "at 10" is 10am, already gone -> tomorrow.
  const r = ok(parseAppointmentTime("at 10", CHI, NOW));
  assert.equal(zonedParts(r.at, CHI).day, 31);
  // "at 4" is 4pm, still ahead -> today.
  const later = ok(parseAppointmentTime("at 4", CHI, NOW));
  assert.equal(zonedParts(later.at, CHI).day, 30);
});

// ---- parseAppointmentTime: the refusals ---------------------------------

test("parseAppointmentTime: refuses a time in the past", () => {
  const r = parseAppointmentTime("today at 9am", CHI, NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /already passed/i);
});

test("parseAppointmentTime: refuses a phrase with no clock time", () => {
  const r = parseAppointmentTime("sometime next week", CHI, NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /time of day/i);
});

test("parseAppointmentTime: refuses a date beyond the sanity horizon", () => {
  const r = parseAppointmentTime("March 3rd at 2pm", CHI, NOW); // ~7 months out
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, new RegExp(String(MAX_DAYS_AHEAD)));
});

test("parseAppointmentTime: refuses empty input and an unusable timezone", () => {
  assert.equal(parseAppointmentTime("", CHI, NOW).ok, false);
  assert.equal(parseAppointmentTime(null, CHI, NOW).ok, false);
  assert.equal(parseAppointmentTime("tomorrow at 2pm", "Mars/Olympus", NOW).ok, false);
  assert.equal(parseAppointmentTime("tomorrow at 2pm", "", NOW).ok, false);
});

// ---- the spoken string and the SMS agree --------------------------------

test("speakTime + buildConfirmSms describe the same instant", () => {
  const at = new Date("2026-08-04T19:30:00.000Z"); // Tue 2:30pm CDT
  assert.equal(speakTime(at, CHI), "Tuesday, August 4 at 2:30 pm");
  const sms = buildConfirmSms({ firstName: "Mark", aiName: "Sarah", companyName: "Frenkel Financial", at, timeZone: CHI });
  assert.equal(sms, "Hi Mark, this is Sarah with Frenkel Financial — you're confirmed for Tuesday, August 4 at 2:30 PM CDT. Reply STOP to opt out.");
});

test("buildConfirmSms: every fact degrades on its own and STOP always survives", () => {
  const at = new Date("2026-08-04T19:30:00.000Z");
  const bare = buildConfirmSms({ at, timeZone: CHI });
  assert.equal(bare, "Hi, this is the assistant — you're confirmed for Tuesday, August 4 at 2:30 PM CDT. Reply STOP to opt out.");
  assert.ok(!bare.includes("undefined") && !bare.includes("null"));
  for (const s of [
    buildConfirmSms({ firstName: "Mark", at, timeZone: CHI }),
    buildConfirmSms({ aiName: "Sarah", at, timeZone: CHI }),
    buildConfirmSms({ companyName: "Frenkel Financial", at, timeZone: CHI }),
  ]) assert.match(s, /Reply STOP to opt out\.$/);
});

test("buildConfirmSms: the time is rendered in the LEAD's zone", () => {
  const at = new Date("2026-08-04T19:30:00.000Z");
  assert.match(buildConfirmSms({ at, timeZone: LAX }), /12:30 PM PDT/);
  assert.match(buildConfirmSms({ at, timeZone: NYC }), /3:30 PM EDT/);
});
