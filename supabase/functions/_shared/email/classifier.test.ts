// ============================================================
// classifier.test.ts — run with:  npm run test:email   (Node 24, no deps)
//
// Two layers of coverage:
//  A) Data-driven: every sample_subjects entry in carrier_sender_map.json is
//     classified and must resolve to that row's email_type/content_type/route.
//     The JSON map is the behavioral oracle; the TS mirror is the input data.
//  B) Targeted: the known traps (aatx case-insensitivity, Ethos allowlist,
//     MoO personal-address vs specific-sender priority, Americo noreply vs
//     donotreply, TA multi-subject split, login-link nudges, unclassified,
//     non-carrier drop).
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyMessage, extractEmailAddress, likeToRegExp } from "./classifier.ts";

const map = JSON.parse(
  readFileSync(new URL("../../../../docs/carrier_sender_map.json", import.meta.url), "utf8"),
);

// Concrete sample From for wildcard (SQL-LIKE) from_patterns.
const CONCRETE_FROM: Record<string, string> = {
  "%@mutualofomaha.com": "aubrey.street-mccarthy@mutualofomaha.com",
  "%@american-amicablegroup.ccsend.com": "news@american-amicablegroup.ccsend.com",
  "%@sales.transamerica.com": "xavier.gerken@sales.transamerica.com",
};
const fromFor = (pattern: string) => CONCRETE_FROM[pattern] ?? pattern;

// ---------- A) Data-driven from the map ----------
test("every sample subject classifies to its owning map row", () => {
  for (const row of map.senders) {
    for (const subject of row.sample_subjects ?? []) {
      const from = fromFor(row.from_pattern);
      const c = classifyMessage(from, subject);
      assert.ok(c, `no classification for ${from} / "${subject}"`);
      assert.equal(c.status, "matched", `expected match for ${from} / "${subject}"`);
      if (c.status !== "matched") continue;
      assert.equal(c.email_type, row.email_type, `email_type for "${subject}"`);
      assert.equal(c.content_type, row.content_type, `content_type for "${subject}"`);
      assert.equal(c.route, row.route, `route for "${subject}"`);
      assert.equal(c.carrier, row.carrier, `carrier for "${subject}"`);
    }
  }
});

// ---------- B) Targeted traps ----------

test("aatx.com is matched case-insensitively and split on subject", () => {
  const activity = classifyMessage("NOREPLY@aatx.com", "APPLICATION ACTIVITY");
  assert.equal(activity?.status, "matched");
  assert.equal(activity && activity.status === "matched" && activity.email_type, "application_activity");

  const returned = classifyMessage("noreply@aatx.com", "Returned Payment - JACE FRENKEL 1190043, 0113615870");
  assert.equal(returned && returned.status === "matched" && returned.email_type, "payment_result");

  // aatx address, subject matching neither pattern -> unclassified (review), not dropped
  const novel = classifyMessage("NOREPLY@aatx.com", "Some brand new subject");
  assert.equal(novel?.status, "unclassified");
  assert.equal(novel && novel.status === "unclassified" && novel.route, "review");
});

test("Ethos one sender: allowlist transactional, default to ignore", () => {
  const app = classifyMessage("ethosforagent@mail.ethos-agents.com", "Help Jon Ellison complete their insurance application");
  assert.equal(app && app.status === "matched" && app.email_type, "application_activity");

  const comp = classifyMessage("ethosforagent@mail.ethos-agents.com", "Ethos Independence Day compensation processing update");
  assert.equal(comp && comp.status === "matched" && comp.email_type, "commission_change");

  const mktg = classifyMessage("ethosforagent@mail.ethos-agents.com", "Join the Ethos masterclass and unlock your potential");
  assert.equal(mktg && mktg.status === "matched" && mktg.email_type, "ignore");
  assert.equal(mktg && mktg.status === "matched" && mktg.route, "ignore");
});

test("MoO specific sender wins over domain-wide underwriter catch (priority)", () => {
  // igo_eapp is a specific address (priority 10); the %@mutualofomaha.com row
  // (priority 50) also matches the address — the specific row must win.
  const eapp = classifyMessage("do_not_reply_igo_eapp@mutualofomaha.com", "New E-App Submitted Larry  Didlo -Policy # BU6691749");
  assert.equal(eapp && eapp.status === "matched" && eapp.email_type, "application_activity");

  // A personal underwriter address only matches the domain-wide row, gated by subject.
  const uw = classifyMessage('"Aubrey Street-McCarthy" <aubrey.street-mccarthy@mutualofomaha.com>', "App Review BU6691749, DIDLO");
  assert.equal(uw && uw.status === "matched" && uw.email_type, "underwriting_status");

  // Personal address, non-underwriting subject -> unclassified (surface novel format).
  const other = classifyMessage("aubrey.street-mccarthy@mutualofomaha.com", "Quick question about your case");
  assert.equal(other?.status, "unclassified");
});

test("Americo noreply vs donotreply split by sender + subject", () => {
  const daily = classifyMessage("noreply@americo.com", "Americo Daily Update");
  assert.equal(daily && daily.status === "matched" && daily.email_type, "commission_summary");
  assert.equal(daily && daily.status === "matched" && daily.route, "commission_summary");

  const portal = classifyMessage("donotreply@americo.com", "Americo - New Notification Regarding Michael Kjenstad");
  assert.equal(portal && portal.status === "matched" && portal.email_type, "portal_notification");
  assert.equal(portal && portal.status === "matched" && portal.content_type, "login_link");
  assert.equal(portal && portal.status === "matched" && portal.route, "nudge");

  // noreply.collections must NOT be caught by the noreply@ exact pattern.
  const debt = classifyMessage("noreply.collections@americo.com", "Americo Debt Notification");
  assert.equal(debt && debt.status === "matched" && debt.email_type, "commission_change");
});

test("Transamerica notifications@ splits across three subject types", () => {
  const results = [
    ["KAREN MCCANDIES Application Results", "underwriting_status"],
    ["Payment Scheduled", "payment_result"],
    ["Your Policy Documents Are Ready", "policy_active"],
  ] as const;
  for (const [subject, expected] of results) {
    const c = classifyMessage("notifications@mylifeinsurance.transamerica.com", subject);
    assert.equal(c && c.status === "matched" && c.email_type, expected, `subject "${subject}"`);
  }
});

test("login-link carriers route to nudge with login_link content", () => {
  const cb = classifyMessage("svc_ilcc_prod@corebridgefinancial.com", "Your requested Corebridge Financial documents");
  assert.equal(cb && cb.status === "matched" && cb.content_type, "login_link");
  assert.equal(cb && cb.status === "matched" && cb.route, "nudge");
});

test("unknown sender at a known carrier domain -> unclassified/review", () => {
  const c = classifyMessage("someone.new@corebridgefinancial.com", "A subject we've never seen");
  assert.equal(c?.status, "unclassified");
  assert.equal(c && c.status === "unclassified" && c.carrier, "corebridge");
  assert.equal(c && c.status === "unclassified" && c.route, "review");
});

test("non-carrier email is dropped (null), not queued", () => {
  assert.equal(classifyMessage("newsletter@some-random-domain.com", "Weekly digest"), null);
  assert.equal(classifyMessage("not-an-address", "hi"), null);
  assert.equal(classifyMessage("", ""), null);
});

// ---------- helpers ----------
test("extractEmailAddress handles display names and casing", () => {
  assert.equal(extractEmailAddress("Underwriter <A.B@Carrier.com>"), "a.b@carrier.com");
  assert.equal(extractEmailAddress("NOREPLY@AATX.COM"), "noreply@aatx.com");
  assert.equal(extractEmailAddress('"Team" <team@x.io>'), "team@x.io");
});

test("likeToRegExp: '%' wildcard, literal dots, no over-match", () => {
  assert.ok(likeToRegExp("%@mutualofomaha.com").test("a.b@mutualofomaha.com"));
  assert.ok(!likeToRegExp("noreply@americo.com").test("noreply.collections@americo.com"));
  assert.ok(!likeToRegExp("noreply@americo.com").test("noreplyXamerico.com")); // '.' is literal
});
