// ============================================================
// ai-assistant-start.test.ts — run with:  npm run test:ai
//
// Source-text guards on the ONE code path where a mistake is a real person
// holding a silent phone: ai-call-webhook's startAssistant().
//
// This file exists because that path has now been broken twice, the same way
// both times — something new was put on it and there was no way back:
//
//   2026-07-27  `message_history` was sent. Telnyx's validator 422s it on this
//               account (code 10000, pointer /message_history). Every Phase 1
//               test call was dead air until the 5-minute cap.
//   2026-07-30  `assistant.dynamic_variables` was added as rung 1 to hand the
//               webhook tools an exact ai_call_id. Telnyx answered 503, the
//               ladder's `>= 500` break meant no second attempt was ever made,
//               and the lead heard nothing. (ai_call_events, call_control_id
//               v3:hxdqhlTP2…, 20:37.)
//
// Both were caught by a live call rather than by anything in the repo. These
// are cheap assertions on the shipping source; they cannot prove the body is
// accepted, but they can stop the two specific regressions from returning.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "ai-call-webhook", "index.ts"), "utf8");

/** Just the body of startAssistant(), so a mention in a comment elsewhere doesn't count. */
function startAssistantBody(): string {
  const i = SRC.indexOf("async function startAssistant(");
  assert.ok(i > 0, "startAssistant() not found — this test is pinned to the wrong thing");
  // Ends at the dead-air fallback that follows it.
  const j = SRC.indexOf("async function deadAirFallback(", i);
  assert.ok(j > i, "deadAirFallback() not found after startAssistant()");
  return SRC.slice(i, j);
}

/** Code only: comments explain WHY these are banned, so they must be allowed to say the words. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("NOTHING sends message_history on ai_assistant_start", () => {
  const code = stripComments(startAssistantBody());
  assert.ok(
    !/message_history/.test(code),
    "message_history is back on the assistant-start path. Telnyx 422s it on this account " +
    "(code 10000, pointer /message_history) and the call becomes dead air.",
  );
});

test("no dynamic_variables on the assistant-start path", () => {
  const code = stripComments(startAssistantBody());
  assert.ok(
    !/dynamic_variables/.test(code),
    "assistant.dynamic_variables is back on the greeting's critical path. It was tried on " +
    "2026-07-30, came back 503, and the lead heard silence. ai-call-tools identifies the call " +
    "from telnyx_call_to/telnyx_call_from, which Telnyx merges in automatically and which cost " +
    "this path nothing.",
  );
});

test("the first rung is the PROVEN body — assistant id + greeting, nothing else", () => {
  const body = startAssistantBody();
  const firstPush = body.indexOf("attempts.push(");
  assert.ok(firstPush > 0, "no attempt ladder found");
  // Everything before the first rung is where a new field would be smuggled in.
  const preamble = stripComments(body.slice(0, firstPush));
  const declared = preamble.match(/^\s*(?:const|let)\s+(\w+)/gm) || [];
  const names = declared.map((d) => d.replace(/^\s*(?:const|let)\s+/, ""));
  for (const n of names) {
    assert.ok(
      ["greeting", "attempts", "full", "lastStatus", "lastText"].includes(n),
      `startAssistant() builds a new value "${n}" before its first attempt. Anything on this ` +
      `path is dead air if Telnyx dislikes it — put it on a later rung, or not at all.`,
    );
  }
});

test("a 5xx must NOT abandon the ladder", () => {
  const code = stripComments(startAssistantBody());
  // The exact shape of the bug: bailing out of the whole ladder on a 5xx.
  assert.ok(
    !/break;[\s]*\}[\s]*$/m.test("") && !/res\.status\s*>=\s*500[\s\S]{0,40}break/.test(code),
    "startAssistant() breaks out of the attempt ladder on a 5xx. That is what turned a single " +
    "503 into a dead call on 2026-07-30: rung 2 (the proven body) was never tried. A 5xx is not " +
    "reliable evidence about the request body — a validator may answer 503 — and it is often " +
    "transient, so it deserves a retry and then the next rung.",
  );
  assert.match(
    code, /res\.status\s*<\s*500[\s\S]{0,40}break/,
    "expected the ladder to stop repeating a body only on a 4xx (a verdict on the body) and to " +
    "retry/continue on a 5xx.",
  );
});

test("every failure path still ends the call rather than leaving dead air", () => {
  const code = stripComments(startAssistantBody());
  assert.match(
    code, /error_detail/,
    "a total failure must be written to ai_calls.error_detail — that is what zeroes the bill for " +
    "our own failure and what makes a silent call diagnosable.",
  );
  assert.match(
    code, /hangupCall\(\)/,
    "a total failure must hang up rather than leave the lead listening to silence until the cap.",
  );
});
