// ============================================================
// ai-inbound-webhook.test.ts — run with:  npm run test:ai
//
// The inbound state machine lives inside ai-call-webhook's serve() handler and
// cannot be imported without running a server, so these are source-text guards
// on the shipping file — the same technique as ai-assistant-start.test.ts, and
// for the same reason: every incident in this feature so far was caught by a
// live phone call and nothing in the repo.
//
// They cannot prove behaviour. They CAN stop the specific invariants below
// from being edited away silently, which is what this round's design rests on.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(HERE, "..", p), "utf8");

const WEBHOOK = read("ai-call-webhook/index.ts");
const TOOLS   = read("ai-call-tools/index.ts");
const STATUS  = read("telnyx-call-status/index.ts");
const INBOUND = read("_shared/ai-inbound.ts");

/** Code only — the comments explain WHY these rules exist and must say the words. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ---- the billing split ---------------------------------------------------

test("the human-rate split is scoped to direction='inbound'", () => {
  const c = code(WEBHOOK);
  assert.match(
    c, /direction\s*===\s*"inbound"\s*&&[\s\S]{0,60}answered_by\s*===\s*"agent"/,
    "The rate split must test BOTH direction and answered_by. An outbound warm " +
    "transfer is also answered by the agent and still bills entirely at the " +
    "ai_call rate (Round C decision); keying on answered_by alone would " +
    "silently re-rate every successful outbound transfer.",
  );
});

test("an agent-answered inbound call takes ZERO ai_call minutes", () => {
  const c = code(WEBHOOK);
  assert.match(
    c, /agentAnsweredInbound[\s\S]{0,80}\?\s*0/,
    "billed minutes must be forced to 0 when the agent answered an inbound call — " +
    "otherwise it is charged at the AI rate for a call no AI was on, AND again " +
    "at the human rate by settleBridgedInbound.",
  );
  assert.match(
    c, /settleBridgedInbound/,
    "the human-rate settlement must actually be called",
  );
});

test("the human settlement is idempotent on the inbound call_control_id", () => {
  const c = code(WEBHOOK);
  const fn = c.slice(c.indexOf("async function settleBridgedInbound"));
  assert.match(
    fn, /sw_call_sid[\s\S]{0,200}if\s*\(existing\)\s*return/,
    "a replayed hangup must find the existing calls row and do nothing — " +
    "without this an inbound call the agent took is billed twice.",
  );
});

// ---- the inbound bridge --------------------------------------------------

test("the inbound bridge ANSWERS the caller's leg before bridging", () => {
  const c = code(WEBHOOK);
  const branch = c.slice(c.indexOf("isInboundAgentLeg"));
  assert.match(
    branch, /actions\/answer/,
    "On inbound the caller's leg has never been answered — they are on carrier " +
    "ringback. Bridging without answering first bridges to a leg that is not up.",
  );
  assert.match(
    branch, /role:\s*"inbound_bridged"/,
    "the answered leg must be tagged so no assistant is attached to it",
  );
});

test("both inbound resolutions claim answered_by ATOMICALLY", () => {
  const c = code(WEBHOOK);
  // The ring timeout and a press-1 can land together. Whichever wins must be
  // the only one that resolves the call, or the caller is answered twice.
  const claims = c.match(/\.is\("answered_by",\s*null\)/g) || [];
  assert.ok(
    claims.length >= 2,
    `expected the AI takeover AND the bridge to each compare-and-set on ` +
    `answered_by is null; found ${claims.length}`,
  );
});

test("a bridged inbound leg never starts an assistant", () => {
  const c = code(WEBHOOK);
  assert.match(
    c, /ctx\.role\s*===\s*"inbound_bridged"/,
    "the bridged caller leg must be recognised and excluded from call.answered",
  );
  assert.match(
    c, /eventType === "call\.answered" && ctx\.role !== "inbound_bridged"/,
    "the assistant-start path must explicitly exclude the bridged leg",
  );
});

// ---- never re-ring the agent --------------------------------------------

test("an inbound AI call can NEVER warm-transfer back to the agent", () => {
  const c = code(TOOLS);
  assert.match(
    c, /call\.direction\s*===\s*"inbound"/,
    "transfer_to_agent must refuse on inbound. The agent's phone already rang " +
    "for 15 seconds and they did not pick up; ringing them again mid-conversation " +
    "is what makes people hang up on automated systems. This is a RULE, so it " +
    "lives in the handler and not only in the prompt.",
  );
  const idx = c.indexOf('call.direction === "inbound"');
  const after = c.slice(idx, idx + 900);
  assert.ok(
    !/api\.telnyx\.com\/v2\/calls/.test(after),
    "the inbound refusal must return before any dial is placed",
  );
});

// ---- the routing seam ----------------------------------------------------

test("the AI-inbound guard sits AFTER the power-dialer check", () => {
  const c = code(STATUS);
  const dialer = c.indexOf("isDialerCall");
  // The CALL SITE, not the import at the top of the file — which is what this
  // assertion matched on its first run, and would have gone on passing no
  // matter where the branch actually sat.
  const ai = c.indexOf("await startInboundIfEnabled(");
  assert.ok(dialer > 0 && ai > dialer,
    "the power dialer must get first refusal on every inbound call — its PIN IVR " +
    "is how agents start a dialing session.");
  assert.match(
    c, /if \(isDialerCall\)[\s\S]{0,600}return new Response\("ok"\);\s*\}/,
    "the dialer branch must return before the AI branch is reached",
  );
});

test("the abandoned-caller hook cannot claim a power-dialer leg", () => {
  const c = code(STATUS);
  assert.match(
    c, /if \(!ctx\.role && callControlId\)[\s\S]{0,160}cancelInboundIfAbandoned/,
    "every power-dialer leg carries a client_state role; the inbound hook must " +
    "only look at legs that have none.",
  );
});

test("inbound answers redirect later events to ai-call-webhook", () => {
  // The hinge of the whole design: without the override, finalize, insights and
  // the wallet debit would keep arriving at telnyx-call-status, which knows
  // none of them.
  for (const [name, src] of [["ai-inbound", INBOUND], ["ai-call-webhook", WEBHOOK]] as const) {
    const c = code(src);
    assert.match(c, /functions\/v1\/ai-call-webhook/, `${name} must set the webhook override`);
  }
  const c = code(INBOUND);
  const answerBlock = c.slice(c.indexOf("actions/answer"));
  assert.match(answerBlock.slice(0, 500), /webhook_url/,
    "the answer action itself must carry webhook_url");
});

// ---- TCPA ----------------------------------------------------------------

test("an inbound-created lead never gets TCPA consent", () => {
  const c = code(INBOUND);
  const fn = c.slice(c.indexOf("export function buildInboundLeadRow"));
  assert.match(fn, /tcpa_consent:\s*false/,
    "Calling us makes ANSWERING lawful. It is not consent to be dialed by an " +
    "artificial voice tomorrow, and ai-call-start's gate must keep refusing them.");
});

test("quiet hours do not gate answering an inbound call", () => {
  const c = code(INBOUND);
  assert.ok(
    !/isWithinAllowedHours|quiet_hours/.test(c),
    "the consumer dialed us; refusing to pick up at 9:05pm protects nobody. " +
    "Quiet hours still gate the outbound confirmation SMS, in runComplianceGate.",
  );
});
