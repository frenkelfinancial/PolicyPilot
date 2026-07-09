// ============================================================
// tcpa.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  timezoneForPhone,
  knownTimezoneForPhone,
  isWithinAllowedHours,
  isWithinAllowedHoursUnknownTz,
  isSendAllowedForPhone,
  AREA_CODE_TIMEZONES,
} from "./tcpa.ts";

test("timezoneForPhone resolves a known area code (E.164 with +1)", () => {
  assert.equal(timezoneForPhone("+12125551234"), "America/New_York");
});

test("timezoneForPhone resolves a known area code (bare 10-digit)", () => {
  assert.equal(timezoneForPhone("2135551234"), "America/Los_Angeles");
});

test("timezoneForPhone respects Arizona's no-DST Mountain zone", () => {
  assert.equal(timezoneForPhone("+16025551234"), "America/Phoenix");
});

test("timezoneForPhone falls back to the default for an unmapped area code (display only)", () => {
  assert.equal(timezoneForPhone("+19995551234", "America/New_York"), "America/New_York");
});

test("knownTimezoneForPhone: null for an unmapped area code", () => {
  assert.equal(knownTimezoneForPhone("+19995551234"), null);
});

test("knownTimezoneForPhone: null for every toll-free prefix (no geography)", () => {
  for (const prefix of ["800", "888", "877", "866", "855", "844", "833"]) {
    assert.equal(knownTimezoneForPhone(`+1${prefix}5551234`), null, `expected null for toll-free prefix ${prefix}`);
  }
});

test("knownTimezoneForPhone: resolves the same known codes as timezoneForPhone", () => {
  assert.equal(knownTimezoneForPhone("+12125551234"), "America/New_York");
  assert.equal(knownTimezoneForPhone("+12135551234"), "America/Los_Angeles");
});

test("every mapped timezone is a valid IANA zone Intl can format", () => {
  const zones = new Set(Object.values(AREA_CODE_TIMEZONES));
  for (const tz of zones) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date()));
  }
});

test("isWithinAllowedHours: noon Eastern is within the 8am-9pm window", () => {
  // 2026-07-09T16:00:00Z = 12:00 noon EDT (UTC-4 in July).
  const noon = new Date("2026-07-09T16:00:00Z");
  assert.equal(isWithinAllowedHours(noon, "America/New_York"), true);
});

test("isWithinAllowedHours: 2am Eastern is outside the window", () => {
  // 2026-07-09T06:00:00Z = 2:00am EDT.
  const earlyMorning = new Date("2026-07-09T06:00:00Z");
  assert.equal(isWithinAllowedHours(earlyMorning, "America/New_York"), false);
});

test("isWithinAllowedHours: exactly 9:00pm local is outside (end is exclusive)", () => {
  // 2026-07-10T01:00:00Z = 9:00pm EDT on 2026-07-09.
  const ninePm = new Date("2026-07-10T01:00:00Z");
  assert.equal(isWithinAllowedHours(ninePm, "America/New_York"), false);
});

test("isWithinAllowedHours: exactly 8:00am local is inside (start is inclusive)", () => {
  // 2026-07-09T12:00:00Z = 8:00am EDT.
  const eightAm = new Date("2026-07-09T12:00:00Z");
  assert.equal(isWithinAllowedHours(eightAm, "America/New_York"), true);
});

test("isWithinAllowedHours: same instant differs by timezone (Pacific still pre-8am)", () => {
  // 2026-07-09T12:00:00Z = 8:00am EDT but only 5:00am PDT.
  const instant = new Date("2026-07-09T12:00:00Z");
  assert.equal(isWithinAllowedHours(instant, "America/New_York"), true);
  assert.equal(isWithinAllowedHours(instant, "America/Los_Angeles"), false);
});

// ---- Fix 5: known western code near its own boundary ----

test("isSendAllowedForPhone: known LA number is blocked just before its own 8am boundary", () => {
  // 2026-07-09T14:59:00Z = 7:59am PDT (UTC-7 in July).
  const justBefore8amPacific = new Date("2026-07-09T14:59:00Z");
  assert.equal(isSendAllowedForPhone("+12135551234", justBefore8amPacific), false);
});

test("isSendAllowedForPhone: known LA number is allowed exactly at its own 8am boundary", () => {
  // 2026-07-09T15:00:00Z = 8:00am PDT.
  const exactly8amPacific = new Date("2026-07-09T15:00:00Z");
  assert.equal(isSendAllowedForPhone("+12135551234", exactly8amPacific), true);
});

// ---- Fix 5: unmapped/toll-free numbers use the conservative NY/LA
//      intersection window instead of silently defaulting to Eastern ----

test("isWithinAllowedHoursUnknownTz: blocked at 8:30am Eastern (would be 5:30am Pacific)", () => {
  const eightThirtyAmEastern = new Date("2026-07-09T12:30:00Z");
  assert.equal(isWithinAllowedHoursUnknownTz(eightThirtyAmEastern), false);
});

test("isWithinAllowedHoursUnknownTz: allowed at noon Eastern (9am Pacific, both open)", () => {
  const noonEastern = new Date("2026-07-09T16:00:00Z");
  assert.equal(isWithinAllowedHoursUnknownTz(noonEastern), true);
});

test("isSendAllowedForPhone: toll-free number blocked at 8:30am Eastern", () => {
  const eightThirtyAmEastern = new Date("2026-07-09T12:30:00Z");
  assert.equal(isSendAllowedForPhone("+18005551234", eightThirtyAmEastern), false);
});

test("isSendAllowedForPhone: toll-free number allowed at noon Eastern", () => {
  const noonEastern = new Date("2026-07-09T16:00:00Z");
  assert.equal(isSendAllowedForPhone("+18005551234", noonEastern), true);
});

test("isSendAllowedForPhone: unmapped (non-toll-free) area code also uses the intersection window", () => {
  const eightThirtyAmEastern = new Date("2026-07-09T12:30:00Z");
  const noonEastern = new Date("2026-07-09T16:00:00Z");
  assert.equal(isSendAllowedForPhone("+19995551234", eightThirtyAmEastern), false);
  assert.equal(isSendAllowedForPhone("+19995551234", noonEastern), true);
});
