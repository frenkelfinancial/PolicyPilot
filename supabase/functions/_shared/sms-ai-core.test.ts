// ============================================================
// sms-ai-core.test.ts — run with:  npm run test:ai
//
// Every decision the AI texting agent makes, tested without a database, a
// provider or a model. The structural half (what the edge functions and the
// migration actually contain) is in test/sms-ai-responder.test.mjs.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HOT_ALERT_THROTTLE_MS,
  NUDGE_OFFSETS_MS,
  SMS_AI_MAX_PAIRS,
  SMS_AI_TYPES,
  SMS_AI_TYPE_LABELS,
  buildSystemPrompt,
  defaultSmsAiSettings,
  deferNudge,
  hotAlertAllowed,
  hotAlertSms,
  isOptOutKeyword,
  matchCustomPair,
  normalizePairs,
  normalizeSmsAiSettings,
  nextNudge,
  nudgeAllowedAt,
  nudgeStepsFor,
  refusalSurfacesToAgent,
  shouldAutoMute,
  smsAiGate,
  tidyReply,
  wantsHuman,
  warmHoldingLine,
} from "./sms-ai-core.ts";

// ============================================================
// 1. THE GATE — order is the whole point
// ============================================================

/** Everything allowed. Individual tests break one thing at a time. */
const OPEN = {
  text: "how much would it be",
  isOptOut: false,
  onDnc: false,
  hasConsent: true,
  accountEnabled: true,
  planEntitled: true,
  conversationStatus: "open",
  aiMuted: false,
  typeEnabled: true,
  hasLead: true,
};

test("a fully open conversation is answered", () => {
  assert.equal(smsAiGate(OPEN), null);
});

test("🔴 STOP is decided BEFORE anything else, including the AI", () => {
  // The one refusal that is a legal obligation rather than a product
  // decision. It must win over every other state, including states that
  // would themselves refuse.
  assert.equal(smsAiGate({ ...OPEN, isOptOut: true }), "stop_keyword");
  assert.equal(smsAiGate({ ...OPEN, isOptOut: true, hasConsent: false }), "stop_keyword");
  assert.equal(smsAiGate({ ...OPEN, isOptOut: true, aiMuted: true }), "stop_keyword");
  assert.equal(smsAiGate({ ...OPEN, isOptOut: true, planEntitled: false }), "stop_keyword");
  assert.equal(smsAiGate({ ...OPEN, isOptOut: true, conversationStatus: "closed" }), "stop_keyword");
});

test("🔴 no consent, no AI reply — and it outranks every business gate", () => {
  assert.equal(smsAiGate({ ...OPEN, hasConsent: false }), "no_consent");
  // An expired plan does not make it acceptable to text somebody who never
  // agreed; the consumer's answer comes first either way.
  assert.equal(smsAiGate({ ...OPEN, hasConsent: false, planEntitled: false }), "no_consent");
  assert.equal(smsAiGate({ ...OPEN, hasConsent: false, accountEnabled: false }), "no_consent");
});

test("a suppressed contact is refused above consent's own check", () => {
  assert.equal(smsAiGate({ ...OPEN, onDnc: true }), "opted_out");
  assert.equal(smsAiGate({ ...OPEN, onDnc: true, hasConsent: true }), "opted_out");
});

test("the account gates come after the consumer ones, in a fixed order", () => {
  assert.equal(smsAiGate({ ...OPEN, accountEnabled: false }), "account_disabled");
  assert.equal(smsAiGate({ ...OPEN, planEntitled: false }), "upgrade_required");
  assert.equal(smsAiGate({ ...OPEN, accountEnabled: false, planEntitled: false }), "account_disabled");
});

test("the per-thread gates come last", () => {
  assert.equal(smsAiGate({ ...OPEN, conversationStatus: "closed" }), "conversation_closed");
  assert.equal(smsAiGate({ ...OPEN, aiMuted: true }), "ai_muted");
  assert.equal(smsAiGate({ ...OPEN, typeEnabled: false }), "type_disabled");
  assert.equal(smsAiGate({ ...OPEN, hasLead: false }), "no_lead");
});

test("an empty message is refused before we spend a model call on it", () => {
  for (const t of ["", "   ", "\n\t"]) {
    assert.equal(smsAiGate({ ...OPEN, text: t }), "empty_message");
  }
});

test("the full precedence chain, one break at a time", () => {
  // Reading down: each refusal wins over everything below it.
  const order = [
    ["isOptOut", true, "stop_keyword"],
    ["onDnc", true, "opted_out"],
    ["hasConsent", false, "no_consent"],
    ["text", "", "empty_message"],
    ["accountEnabled", false, "account_disabled"],
    ["planEntitled", false, "upgrade_required"],
    ["conversationStatus", "closed", "conversation_closed"],
    ["aiMuted", true, "ai_muted"],
    ["typeEnabled", false, "type_disabled"],
    ["hasLead", false, "no_lead"],
  ] as const;

  for (let i = 0; i < order.length; i++) {
    // Break this one AND every one below it: the higher must still win.
    const input: Record<string, unknown> = { ...OPEN };
    for (let j = i; j < order.length; j++) input[order[j][0]] = order[j][1];
    assert.equal(smsAiGate(input as never), order[i][2], `breaking from ${order[i][0]} down`);
  }
});

test("a refusal still shows the agent the thread, except the two that need no one", () => {
  // A STOP is handled and confirmed; an empty text is nothing. Everything
  // else is a conversation a human should look at.
  assert.equal(refusalSurfacesToAgent("stop_keyword"), false);
  assert.equal(refusalSurfacesToAgent("empty_message"), false);
  assert.equal(refusalSurfacesToAgent(null), false);
  for (const r of ["no_consent", "upgrade_required", "ai_muted", "account_disabled", "no_lead"] as const) {
    assert.equal(refusalSurfacesToAgent(r), true, r);
  }
});

// ============================================================
// 2. OPT-OUT KEYWORDS
// ============================================================

test("the opt-out test is the whole body, and stays narrow", () => {
  for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "cancel", "End", "quit"]) {
    assert.equal(isOptOutKeyword(w), true, w);
  }
  // Narrow on purpose: suppressing this lead would be the worse error.
  for (const w of [
    "please stop by the office on Tuesday",
    "stop it, that's funny",
    "can you cancel my appointment",
    "STOP SENDING ME QUOTES",
    "", "   ", null, undefined,
  ]) {
    assert.equal(isOptOutKeyword(w as string), false, JSON.stringify(w));
  }
});

// ============================================================
// 3. CUSTOM PAIRS
// ============================================================

const PAIRS = [
  { trigger: "price", answer: "Plans start at $28/month." },
  { trigger: "waiting period", answer: "Our waiting period is two years." },
  { trigger: "cancel anytime", answer: "Yes, you can cancel any time." },
];

test("an unambiguous hit is used VERBATIM, with no model call", () => {
  const m = matchCustomPair("what is the price like", PAIRS);
  assert.equal(m.reason, "hit");
  assert.equal(m.answer, "Plans start at $28/month.");
});

test("matching is case-insensitive and matches inside a sentence", () => {
  assert.equal(matchCustomPair("PRICE?", PAIRS).answer, "Plans start at $28/month.");
  assert.equal(matchCustomPair("hey, whats the Waiting Period on this", PAIRS).answer,
    "Our waiting period is two years.");
});

test("🔴 the LONGEST trigger wins, because it is the more specific one", () => {
  const pairs = [
    { trigger: "price", answer: "GENERIC" },
    { trigger: "price list", answer: "SPECIFIC" },
  ];
  assert.equal(matchCustomPair("send me the price list please", pairs).answer, "SPECIFIC");
  // ...and the short one still answers when the long one does not apply.
  assert.equal(matchCustomPair("what is the price", pairs).answer, "GENERIC");
});

test("🔴 a genuine tie is AMBIGUOUS and falls through to the model", () => {
  // Picking one arbitrarily would make the same question get different
  // answers depending on the order the agent happened to type the rows.
  const pairs = [
    { trigger: "aaaa", answer: "one" },
    { trigger: "bbbb", answer: "two" },
  ];
  const m = matchCustomPair("aaaa and bbbb", pairs);
  assert.equal(m.reason, "ambiguous");
  assert.equal(m.answer, null);
  assert.equal(m.matched.length, 2);
});

test("a tie between two IDENTICAL answers is a duplicate, not a conflict", () => {
  const pairs = [
    { trigger: "aaaa", answer: "same" },
    { trigger: "bbbb", answer: "same" },
  ];
  assert.equal(matchCustomPair("aaaa bbbb", pairs).reason, "hit");
});

test("no pairs and no match are told apart", () => {
  assert.equal(matchCustomPair("hello", []).reason, "no_pairs");
  assert.equal(matchCustomPair("hello", PAIRS).reason, "no_match");
  assert.equal(matchCustomPair("", PAIRS).reason, "no_match");
});

test("🔴 a blank trigger is dropped, because it would match EVERY message", () => {
  // Every string contains the empty string, so a blank-trigger row would
  // answer "what are your hours" with whatever was in it.
  const pairs = [
    { trigger: "", answer: "WOULD MATCH EVERYTHING" },
    { trigger: "   ", answer: "SO WOULD THIS" },
    { trigger: "price", answer: "fine" },
  ];
  assert.deepEqual(normalizePairs(pairs), [{ trigger: "price", answer: "fine" }]);
  assert.equal(matchCustomPair("anything at all", pairs).reason, "no_match");
});

test("a pair with no answer is dropped too", () => {
  assert.deepEqual(normalizePairs([{ trigger: "price", answer: "  " }]), []);
});

test("the 20-pair cap holds", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ trigger: `t${i}`, answer: `a${i}` }));
  assert.equal(normalizePairs(many).length, SMS_AI_MAX_PAIRS);
});

// ============================================================
// 4. NUDGES
// ============================================================

const S = defaultSmsAiSettings();

test("the four offsets are 8h / 24h / 48h / 7d from the LEAD's last message", () => {
  assert.equal(NUDGE_OFFSETS_MS[1], 8 * 3600e3);
  assert.equal(NUDGE_OFFSETS_MS[2], 24 * 3600e3);
  assert.equal(NUDGE_OFFSETS_MS[3], 48 * 3600e3);
  assert.equal(NUDGE_OFFSETS_MS[4], 7 * 24 * 3600e3);

  const base = new Date("2026-08-06T15:00:00Z");
  const n1 = nextNudge({ ...S, nudge_48h: true, nudge_7d: true }, base, 0)!;
  assert.equal(n1.step, 1);
  assert.equal(n1.dueAt.toISOString(), "2026-08-06T23:00:00.000Z");
  // Step 2 is 24h from the LEAD's message, not 24h after step 1 — otherwise
  // "8h then 24h" would put the second one at 32h.
  const n2 = nextNudge({ ...S, nudge_48h: true, nudge_7d: true }, base, 1)!;
  assert.equal(n2.dueAt.toISOString(), "2026-08-07T15:00:00.000Z");
});

test("🔴 a step that is switched off is SKIPPED, not a stop", () => {
  // Turning off the 8-hour nudge must not silently disable the 24-hour one
  // behind it — that reads as a broken checkbox and nobody would know.
  const s = { ...S, nudge_8h: false, nudge_24h: true, nudge_48h: false, nudge_7d: true };
  assert.deepEqual(nudgeStepsFor(s), [2, 4]);
  const base = new Date("2026-08-06T15:00:00Z");
  assert.equal(nextNudge(s, base, 0)!.step, 2);
  assert.equal(nextNudge(s, base, 2)!.step, 4);
  assert.equal(nextNudge(s, base, 4), null);
});

test("all four off means no schedule at all, quietly", () => {
  const s = { ...S, nudge_8h: false, nudge_24h: false, nudge_48h: false, nudge_7d: false };
  assert.deepEqual(nudgeStepsFor(s), []);
  assert.equal(nextNudge(s, new Date(), 0), null);
});

test("an exhausted schedule and a missing timestamp both return null", () => {
  assert.equal(nextNudge(S, new Date("2026-08-06T15:00:00Z"), 4), null);
  assert.equal(nextNudge(S, null, 0), null);
  assert.equal(nextNudge(S, "not a date", 0), null);
});

test("defaults are 8h and 24h on, the long tail off", () => {
  assert.deepEqual(nudgeStepsFor(defaultSmsAiSettings()), [1, 2]);
});

// ============================================================
// 5. QUIET HOURS — nudges only, deferred not dropped
// ============================================================

const CHI = "America/Chicago";

test("the nudge window is 9am to 8pm in the LEAD's zone", () => {
  const at = (iso: string) => nudgeAllowedAt(new Date(iso), CHI);
  // 2026-08-06 is a Thursday. Chicago is UTC-5 in August.
  assert.equal(at("2026-08-06T13:59:00Z"), false); //  8:59am
  assert.equal(at("2026-08-06T14:00:00Z"), true);  //  9:00am
  assert.equal(at("2026-08-06T19:00:00Z"), true);  //  2:00pm
  assert.equal(at("2026-08-07T00:59:00Z"), true);  //  7:59pm
  assert.equal(at("2026-08-07T01:00:00Z"), false); //  8:00pm — exclusive
  assert.equal(at("2026-08-07T05:00:00Z"), false); // midnight
});

test("🔴 never on a Sunday, even at noon", () => {
  // 2026-08-09 is a Sunday.
  assert.equal(nudgeAllowedAt(new Date("2026-08-09T17:00:00Z"), CHI), false);
  assert.equal(nudgeAllowedAt(new Date("2026-08-10T17:00:00Z"), CHI), true); // Monday
});

test("🔴 a nudge outside the window is DEFERRED, never dropped", () => {
  const late = new Date("2026-08-07T04:00:00Z"); // 11pm Thursday, Chicago
  const next = deferNudge(late, CHI);
  assert.ok(next.getTime() > late.getTime());
  assert.equal(nudgeAllowedAt(next, CHI), true);
  // Next morning, not next week.
  assert.ok(next.getTime() - late.getTime() < 24 * 3600e3);
});

test("a Saturday night defers past Sunday to Monday morning", () => {
  const sat = new Date("2026-08-09T03:00:00Z"); // 10pm Saturday, Chicago
  const next = deferNudge(sat, CHI);
  assert.equal(nudgeAllowedAt(next, CHI), true);
  const { weekday } = { weekday: next.getUTCDay() };
  assert.notEqual(weekday, 0, "must not land on a Sunday UTC-adjacent slot that is Sunday locally");
  assert.equal(nudgeAllowedAt(next, CHI), true);
});

test("an instant already inside the window is returned unchanged", () => {
  const ok = new Date("2026-08-06T19:00:00Z");
  assert.equal(deferNudge(ok, CHI).getTime(), ok.getTime());
});

test("the window travels with the lead, not with us", () => {
  const t = new Date("2026-08-06T15:00:00Z"); // 10am Chicago, 8am LA, 4pm London
  assert.equal(nudgeAllowedAt(t, "America/Chicago"), true);
  assert.equal(nudgeAllowedAt(t, "America/Los_Angeles"), false); // 8am — too early
});

// ============================================================
// 6. HOT HANDOFF
// ============================================================

test("the alert throttle is one per conversation per four hours", () => {
  assert.equal(HOT_ALERT_THROTTLE_MS, 4 * 3600e3);
  const now = new Date("2026-08-06T18:00:00Z");
  assert.equal(hotAlertAllowed(null, now), true);
  assert.equal(hotAlertAllowed(undefined, now), true);
  assert.equal(hotAlertAllowed("2026-08-06T17:59:00Z", now), false);
  assert.equal(hotAlertAllowed("2026-08-06T14:00:00Z", now), true);  // exactly 4h
  assert.equal(hotAlertAllowed("2026-08-06T13:00:00Z", now), true);
  assert.equal(hotAlertAllowed("not a date", now), true);
});

test("asking for a person is caught without the model's help", () => {
  for (const t of [
    "can you call me",
    "Call me please",
    "give me a call tomorrow",
    "id like to speak to a person",
    "can I talk with someone",
    "are you a real person?",
    "is this a bot",
    "I want a human",
  ]) {
    assert.equal(wantsHuman(t), true, t);
  }
});

test("ordinary messages are not a handoff", () => {
  for (const t of [
    "how much is it",
    "yes tuesday works",
    "whats the waiting period",
    "",
  ]) {
    assert.equal(wantsHuman(t), false, JSON.stringify(t));
  }
});

test("asking for the agent by first name counts", () => {
  assert.equal(wantsHuman("can Jace call me back", "Jace Frenkel"), true);
  assert.equal(wantsHuman("is Jace around", "Jace Frenkel"), true);
  assert.equal(wantsHuman("how much is it", "Jace Frenkel"), false);
  // A two-letter name would match half the alphabet soup in a text.
  assert.equal(wantsHuman("hi there", "Al"), false);
});

test("the alert names the lead and never renders an empty one", () => {
  assert.equal(
    hotAlertSms({ leadName: "Mark J", reason: "asking about pricing", link: "https://x/y" }),
    "Hot text lead: Mark J — asking about pricing. Open: https://x/y",
  );
  assert.equal(hotAlertSms({}), "Hot text lead: A lead.");
  assert.equal(hotAlertSms({ leadName: "  " }), "Hot text lead: A lead.");
});

test("the AI keeps the conversation warm rather than going silent", () => {
  assert.match(warmHoldingLine("Jace"), /Let me get Jace for you/);
  assert.match(warmHoldingLine(null), /Let me get someone for you/);
});

// ============================================================
// 7. AUTO-MUTE
// ============================================================

test("🔴 a person typing takes over; the AI and the system do not", () => {
  assert.equal(shouldAutoMute("agent"), true);
  // Muting on our own confirmations would silence the AI every time it
  // successfully booked somebody.
  assert.equal(shouldAutoMute("ai"), false);
  assert.equal(shouldAutoMute("system"), false);
  assert.equal(shouldAutoMute("lead"), false);
  assert.equal(shouldAutoMute(null), false);
  assert.equal(shouldAutoMute(undefined), false);
});

// ============================================================
// 8. SETTINGS
// ============================================================

test("there are twelve campaign types plus a default, and all are labelled", () => {
  assert.equal(SMS_AI_TYPES.length, 13);
  assert.equal(SMS_AI_TYPES[0], "default");
  for (const t of SMS_AI_TYPES) {
    assert.ok(SMS_AI_TYPE_LABELS[t], `${t} needs a label`);
  }
});

test("🔴 zero setup still gives a working responder", () => {
  const d = normalizeSmsAiSettings(null);
  assert.equal(d.enabled, true);
  assert.equal(d.tone, "friendly");
  assert.equal(d.reply_length, "brief");
  assert.equal(d.emojis, false);
  assert.equal(d.appointment_minutes, 30);
  assert.deepEqual(d.custom_pairs, []);
});

test("garbage in a settings row degrades to the default, never to broken", () => {
  const s = normalizeSmsAiSettings({
    tone: "shouty", reply_length: "epic", appointment_minutes: 9999,
    appointment_label: "   ", custom_pairs: "not an array",
  } as never);
  assert.equal(s.tone, "friendly");
  assert.equal(s.reply_length, "brief");
  assert.equal(s.appointment_minutes, 240);   // clamped, not defaulted
  assert.equal(s.appointment_label, "Consultation");
  assert.deepEqual(s.custom_pairs, []);
});

test("appointment length is clamped to a sane range", () => {
  assert.equal(normalizeSmsAiSettings({ appointment_minutes: 1 } as never).appointment_minutes, 5);
  assert.equal(normalizeSmsAiSettings({ appointment_minutes: 45 } as never).appointment_minutes, 45);
  assert.equal(normalizeSmsAiSettings({ appointment_minutes: -3 } as never).appointment_minutes, 5);
});

// ============================================================
// 9. THE PROMPT
// ============================================================

test("🔴 the compliance rules are in every prompt, whatever the settings", () => {
  for (const tone of ["professional", "friendly", "casual"]) {
    for (const emojis of [true, false]) {
      const p = buildSystemPrompt({ settings: { ...S, tone, emojis } });
      assert.match(p, /automated assistant/, "must never claim to be human");
      assert.match(p, /Never claim or imply you are a person/);
      assert.match(p, /do not argue and do not try to keep them/);
      assert.match(p, /Never guarantee coverage, approval, a rate, or a price/);
    }
  }
});

test("the identity is the same one voice uses — an assistant, named or not", () => {
  const named = buildSystemPrompt({ aiName: "Ava", agentName: "Jace", agencyName: "Frenkel Financial", settings: S });
  assert.match(named, /You are Ava, an assistant working with Jace at Frenkel Financial\./);
  // A blank ai_agent_name stays blank — nothing invents a name the agent did
  // not choose. Same rule as buildGreeting() on the voice side.
  const anon = buildSystemPrompt({ agentName: "Jace", agencyName: "Frenkel Financial", settings: S });
  assert.match(anon, /You are an assistant working with Jace at Frenkel Financial\./);
  assert.ok(!/undefined|null/.test(anon));
});

test("no name, no agent, no agency — still a clean sentence", () => {
  const p = buildSystemPrompt({ settings: S });
  assert.match(p, /^You are an assistant\. You are answering a text message/m);
  assert.ok(!/ at \./.test(p));
  assert.ok(!/undefined/.test(p));
});

test("tone, length and emoji settings each change the prompt", () => {
  assert.match(buildSystemPrompt({ settings: { ...S, tone: "professional" } }), /No slang/);
  assert.match(buildSystemPrompt({ settings: { ...S, tone: "casual" } }), /the way people actually text/);
  assert.match(buildSystemPrompt({ settings: { ...S, reply_length: "medium" } }), /two or three short sentences/);
  assert.match(buildSystemPrompt({ settings: { ...S, emojis: false } }), /Do not use emojis/);
  assert.match(buildSystemPrompt({ settings: { ...S, emojis: true } }), /At most one emoji/);
});

test("the agent's own answers are given to the model as authoritative", () => {
  const p = buildSystemPrompt({ settings: { ...S, custom_pairs: PAIRS } });
  assert.match(p, /THE AGENT'S OWN ANSWERS\. These are authoritative/);
  assert.match(p, /If they ask about "waiting period": Our waiting period is two years\./);
});

test("the appointment settings reach the booking tool's description", () => {
  const p = buildSystemPrompt({ settings: { ...S, appointment_minutes: 45, appointment_label: "Policy Review" } });
  assert.match(p, /45-minute Policy Review/);
});

// ============================================================
// 10. REPLY HYGIENE
// ============================================================

test("markdown and code fences never reach a phone", () => {
  assert.equal(tidyReply("**Hi** there"), "Hi there");
  assert.equal(tidyReply("# Heading\nbody"), "Heading\nbody");
  assert.equal(tidyReply("before ```code here``` after"), "before after");
  assert.equal(tidyReply("a   b\t\tc"), "a b c");
});

test("a long reply is cut on a word boundary, not mid-word", () => {
  const long = "word ".repeat(200);
  const out = tidyReply(long);
  assert.ok(out.length <= 320);
  assert.ok(!out.endsWith("wor"));
  assert.ok(out.endsWith("word"));
});

test("a reply that is already short is untouched", () => {
  assert.equal(tidyReply("Sure — Tuesday at 2 works."), "Sure — Tuesday at 2 works.");
  assert.equal(tidyReply(null), "");
  assert.equal(tidyReply(undefined), "");
});
