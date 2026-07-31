// ============================================================
// sms-ai-core.ts — every decision the AI texting agent makes, with no I/O.
//
// The gate order, the custom-pair match, the nudge schedule, the alert
// throttle, the auto-mute rule and the system prompt are all here so they can
// be tested without a database, a provider or a model — and so the browser can
// mirror the handful of them it also needs (`// <smsai-core>` in app.html).
//
// THE ONE RULE THIS MODULE EXISTS TO PROTECT: an AI reply is only ever
// composed in response to an inbound message from somebody who has already
// recorded SMS consent. Nothing here initiates a conversation. The nudges in
// Part 4 continue a conversation the lead started, and stop the instant they
// say anything at all — including "stop".
// ============================================================

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/** The twelve campaign types, plus the row used when a thread has no campaign. */
export const SMS_AI_TYPES = [
  "default",
  "appointment_reminder",
  "no_show_followup",
  "customer_care_sold",
  "emergency_contact",
  "beneficiary_referral",
  "chargeback_recovery",
  "veteran_lead",
  "final_expense",
  "mortgage_protection",
  "iul",
  "general_life",
  "trucker",
] as const;

/** Human labels for the settings tabs. Kept beside the keys so they cannot drift apart. */
export const SMS_AI_TYPE_LABELS: Record<string, string> = {
  default: "Default",
  appointment_reminder: "Appointment Reminder",
  no_show_followup: "No-Show Follow-Up",
  customer_care_sold: "Customer Care",
  emergency_contact: "Emergency Contact",
  beneficiary_referral: "Beneficiary Referral",
  chargeback_recovery: "Chargeback Recovery",
  veteran_lead: "Veteran Leads",
  final_expense: "Final Expense",
  mortgage_protection: "Mortgage Protection",
  iul: "IUL",
  general_life: "General Life",
  trucker: "Trucker",
};

export const SMS_AI_TONES = ["professional", "friendly", "casual"] as const;
export const SMS_AI_LENGTHS = ["brief", "medium"] as const;
export const SMS_AI_MAX_PAIRS = 20;

export interface SmsAiSettings {
  campaign_type: string;
  enabled: boolean;
  tone: string;
  reply_length: string;
  emojis: boolean;
  nudge_8h: boolean;
  nudge_24h: boolean;
  nudge_48h: boolean;
  nudge_7d: boolean;
  appointment_minutes: number;
  appointment_label: string;
  custom_pairs: Array<{ trigger?: string; answer?: string }>;
}

/**
 * The defaults an agent who has never opened the settings screen gets.
 * `enabled: true` is the point — "sensible defaults so zero setup is required
 * for the AI to work day one".
 */
export function defaultSmsAiSettings(campaignType = "default"): SmsAiSettings {
  return {
    campaign_type: campaignType,
    enabled: true,
    tone: "friendly",
    reply_length: "brief",
    emojis: false,
    nudge_8h: true,
    nudge_24h: true,
    nudge_48h: false,
    nudge_7d: false,
    appointment_minutes: 30,
    appointment_label: "Consultation",
    custom_pairs: [],
  };
}

/** Fill a partial row from the database out to a complete, valid settings object. */
export function normalizeSmsAiSettings(row: Partial<SmsAiSettings> | null | undefined): SmsAiSettings {
  const d = defaultSmsAiSettings(String(row?.campaign_type || "default"));
  if (!row) return d;
  const pick = <T>(v: T | undefined | null, fallback: T): T => (v === undefined || v === null ? fallback : v);
  const tone = String(row.tone || "");
  const len = String(row.reply_length || "");
  const pairs = Array.isArray(row.custom_pairs) ? row.custom_pairs : [];
  return {
    campaign_type: d.campaign_type,
    enabled: pick(row.enabled, d.enabled) === true,
    tone: (SMS_AI_TONES as readonly string[]).includes(tone) ? tone : d.tone,
    reply_length: (SMS_AI_LENGTHS as readonly string[]).includes(len) ? len : d.reply_length,
    emojis: pick(row.emojis, d.emojis) === true,
    nudge_8h: pick(row.nudge_8h, d.nudge_8h) === true,
    nudge_24h: pick(row.nudge_24h, d.nudge_24h) === true,
    nudge_48h: pick(row.nudge_48h, d.nudge_48h) === true,
    nudge_7d: pick(row.nudge_7d, d.nudge_7d) === true,
    appointment_minutes: clampInt(row.appointment_minutes, 5, 240, d.appointment_minutes),
    appointment_label: (String(row.appointment_label || "").trim() || d.appointment_label).slice(0, 60),
    custom_pairs: normalizePairs(pairs),
  };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * Trim, drop the empties, cap at 20.
 *
 * A pair with a blank trigger would match EVERY message (every string contains
 * the empty string), so the AI would answer "what are your hours" with whatever
 * happened to be in that row. Dropping them is not tidying; it is the bug.
 */
export function normalizePairs(
  pairs: Array<{ trigger?: string; answer?: string }> | null | undefined,
): Array<{ trigger: string; answer: string }> {
  const out: Array<{ trigger: string; answer: string }> = [];
  for (const p of pairs || []) {
    const trigger = String(p?.trigger ?? "").trim();
    const answer = String(p?.answer ?? "").trim();
    if (!trigger || !answer) continue;
    out.push({ trigger: trigger.slice(0, 120), answer: answer.slice(0, 480) });
    if (out.length >= SMS_AI_MAX_PAIRS) break;
  }
  return out;
}

// ------------------------------------------------------------
// The gates
// ------------------------------------------------------------

/**
 * Why the AI is not answering this message. `null` means it is.
 *
 * ORDER MATTERS AND IS TESTED. Reading down the list, each answer is more
 * specific than the one below it, and the two that protect a CONSUMER —
 * opted_out and no_consent — sit above every gate that protects the business.
 * An agent whose plan lapsed still must not have a STOP ignored.
 */
export type SmsAiRefusal =
  | "stop_keyword"
  | "opted_out"
  | "no_consent"
  | "account_disabled"
  | "upgrade_required"
  | "conversation_closed"
  | "ai_muted"
  | "type_disabled"
  | "no_lead"
  | "empty_message";

export interface SmsAiGateInput {
  /** The inbound text, already trimmed. */
  text: string;
  /** True when the body is exactly an opt-out keyword — decided by isOptOutKeyword(). */
  isOptOut: boolean;
  /** A dnc_list row exists for this contact (agent-scoped or global). */
  onDnc: boolean;
  /** An acceptable consent_records row exists. */
  hasConsent: boolean;
  /** agents.sms_ai_enabled */
  accountEnabled: boolean;
  /** Plan tier is Pro / Team Leader / admin — same predicate the voice AI uses. */
  planEntitled: boolean;
  /** sms_conversations.status */
  conversationStatus: string;
  /** sms_conversations.ai_muted */
  aiMuted: boolean;
  /** sms_ai_settings.enabled for this thread's type. */
  typeEnabled: boolean;
  /** We could match or create a lead for this number. */
  hasLead: boolean;
}

export function smsAiGate(input: SmsAiGateInput): SmsAiRefusal | null {
  // 1. STOP is handled before the AI is even consulted, and it is handled
  //    whatever else is true. This is the first branch on purpose: it is the
  //    one refusal that is a legal obligation rather than a product decision.
  if (input.isOptOut) return "stop_keyword";
  if (input.onDnc) return "opted_out";

  // 2. Consent. A hard gate — no consent, no AI reply. The conversation is
  //    still surfaced to the agent, who may answer by hand; what may not
  //    happen is a robot texting somebody who never agreed to be texted.
  if (!input.hasConsent) return "no_consent";

  // 3. Nothing to answer.
  if (!String(input.text || "").trim()) return "empty_message";

  // 4. The account.
  if (!input.accountEnabled) return "account_disabled";
  if (!input.planEntitled) return "upgrade_required";

  // 5. This thread.
  if (String(input.conversationStatus || "") === "closed") return "conversation_closed";
  if (input.aiMuted) return "ai_muted";
  if (!input.typeEnabled) return "type_disabled";

  // 6. We need somebody to be talking to.
  if (!input.hasLead) return "no_lead";

  return null;
}

/** Refusals after which the agent should still see the thread, unanswered. */
export function refusalSurfacesToAgent(r: SmsAiRefusal | null): boolean {
  return r !== null && r !== "stop_keyword" && r !== "empty_message";
}

/**
 * The opt-out keyword test.
 *
 * Deliberately the SAME rule messaging-inbound-webhook has always used — the
 * whole body, uppercased and trimmed, equal to one of the five words. It is
 * narrow on purpose: "please stop by the office on Tuesday" is not an opt-out,
 * and treating it as one would suppress a lead who was trying to book.
 */
export const SMS_OPT_OUT_KEYWORDS = ["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"] as const;

export function isOptOutKeyword(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim().toUpperCase();
  return (SMS_OPT_OUT_KEYWORDS as readonly string[]).includes(t);
}

// ------------------------------------------------------------
// Custom pairs — the deterministic pre-match
// ------------------------------------------------------------

export interface PairMatch {
  /** The answer to use verbatim, or null when the model should decide. */
  answer: string | null;
  /** Why. `ambiguous` means more than one pair matched and none is safe to pick. */
  reason: "hit" | "ambiguous" | "no_match" | "no_pairs";
  /** Every pair that matched, longest trigger first. */
  matched: Array<{ trigger: string; answer: string }>;
}

/**
 * Case-insensitive substring pre-match over the agent's pairs.
 *
 * ON AN UNAMBIGUOUS HIT THE ANSWER IS USED VERBATIM — no model call, no
 * paraphrase. That is the entire point of the feature: an agent who writes
 * "our waiting period is two years" wants those words sent, not a friendly
 * approximation of them.
 *
 * "Unambiguous" needs care. Two triggers can both match one message ("price"
 * and "price list"), and the longer one is the more specific, so a strictly
 * longest match wins. A TIE between two different answers is genuinely
 * ambiguous and falls through to the model with both as ground truth —
 * picking one arbitrarily would make the same question get different answers
 * depending on row order.
 */
export function matchCustomPair(
  text: string | null | undefined,
  pairs: Array<{ trigger?: string; answer?: string }> | null | undefined,
): PairMatch {
  const clean = normalizePairs(pairs);
  if (!clean.length) return { answer: null, reason: "no_pairs", matched: [] };

  const hay = String(text ?? "").toLowerCase();
  if (!hay) return { answer: null, reason: "no_match", matched: [] };

  const matched = clean
    .filter((p) => hay.includes(p.trigger.toLowerCase()))
    .sort((a, b) => b.trigger.length - a.trigger.length);

  if (!matched.length) return { answer: null, reason: "no_match", matched: [] };

  const longest = matched[0].trigger.length;
  const tied = matched.filter((p) => p.trigger.length === longest);
  // Same length AND same answer is not a conflict — it is a duplicate.
  const distinct = new Set(tied.map((p) => p.answer));
  if (distinct.size > 1) return { answer: null, reason: "ambiguous", matched };

  return { answer: matched[0].answer, reason: "hit", matched };
}

// ------------------------------------------------------------
// Nudges
// ------------------------------------------------------------

export const NUDGE_OFFSETS_MS: Record<number, number> = {
  1: 8 * 60 * 60 * 1000,
  2: 24 * 60 * 60 * 1000,
  3: 48 * 60 * 60 * 1000,
  4: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Which steps this settings row wants, in order.
 *
 * A step that is off is SKIPPED, not a stop. Turning off the 8-hour nudge
 * must not silently disable the 24-hour one behind it — that reads as a broken
 * checkbox, and the agent would never know.
 */
export function nudgeStepsFor(s: SmsAiSettings): number[] {
  const want = [s.nudge_8h, s.nudge_24h, s.nudge_48h, s.nudge_7d];
  const out: number[] = [];
  for (let i = 0; i < want.length; i++) if (want[i]) out.push(i + 1);
  return out;
}

/**
 * The next nudge after `afterStep`, measured from the last inbound message.
 *
 * Offsets are from the LEAD'S LAST MESSAGE, not from the previous nudge, so
 * the schedule reads the way it is written: 8h, 24h, 48h and 7d after they
 * went quiet. Measuring from the previous nudge would turn "8h/24h" into a
 * message at 8h and another at 32h.
 */
export function nextNudge(
  s: SmsAiSettings,
  lastInboundAt: Date | string | null | undefined,
  afterStep: number,
): { step: number; dueAt: Date } | null {
  const base = toDate(lastInboundAt);
  if (!base) return null;
  for (const step of nudgeStepsFor(s)) {
    if (step <= afterStep) continue;
    return { step, dueAt: new Date(base.getTime() + NUDGE_OFFSETS_MS[step]) };
  }
  return null;
}

/** Everything that cancels a pending nudge. Named so the list is checkable. */
export const NUDGE_CANCEL_REASONS = [
  "lead_replied",
  "opted_out",
  "on_dnc",
  "booked",
  "ai_muted",
  "conversation_closed",
  "settings_disabled",
] as const;
export type NudgeCancelReason = (typeof NUDGE_CANCEL_REASONS)[number];

// ------------------------------------------------------------
// Quiet hours for AI-INITIATED messages
// ------------------------------------------------------------

/**
 * 9am–8pm in the LEAD's zone, never Sunday.
 *
 * This applies to nudges ONLY. A reply to an inbound text goes out at any
 * hour, because they texted us — waiting until 9am to answer somebody who
 * wrote at 11pm is worse service and is not what the rule is for.
 *
 * Stricter than the TCPA gate in _shared/tcpa.ts (8am–9pm) on purpose, and
 * deliberately NOT a replacement for it: runComplianceGate still runs on every
 * send. This is the narrower window the owner asked for; the legal one is
 * enforced underneath regardless.
 */
export const NUDGE_WINDOW_START_HOUR = 9;
export const NUDGE_WINDOW_END_HOUR = 20; // exclusive — 8pm

export function zonedHourAndDay(instant: Date, timeZone: string): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(instant);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const wd = parts.find((p) => p.type === "weekday")?.value || "Mon";
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour: hour === 24 ? 0 : hour, weekday: map[wd] ?? 1 };
}

export function nudgeAllowedAt(instant: Date, timeZone: string): boolean {
  const { hour, weekday } = zonedHourAndDay(instant, timeZone);
  if (weekday === 0) return false;
  return hour >= NUDGE_WINDOW_START_HOUR && hour < NUDGE_WINDOW_END_HOUR;
}

/**
 * The next instant a nudge may go out. DEFERRED, NEVER DROPPED.
 *
 * Walks forward in whole hours to the next allowed slot, which is enough
 * precision for a follow-up text and cannot loop: the window is non-empty on
 * six days of every week, so it terminates within ~48 steps.
 */
export function deferNudge(from: Date, timeZone: string): Date {
  if (nudgeAllowedAt(from, timeZone)) return from;
  const cur = new Date(from.getTime());
  // Round up to the next hour boundary so repeated deferrals converge.
  cur.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 9; i++) {
    cur.setTime(cur.getTime() + 60 * 60 * 1000);
    if (nudgeAllowedAt(cur, timeZone)) return cur;
  }
  return cur;
}

// ------------------------------------------------------------
// Hot handoff
// ------------------------------------------------------------

/** Max one alert per conversation per 4 hours. */
export const HOT_ALERT_THROTTLE_MS = 4 * 60 * 60 * 1000;

export function hotAlertAllowed(lastAlertedAt: Date | string | null | undefined, now: Date): boolean {
  const last = toDate(lastAlertedAt);
  if (!last) return true;
  return now.getTime() - last.getTime() >= HOT_ALERT_THROTTLE_MS;
}

/**
 * Phrases that mean "get me a person", checked before the model is asked.
 *
 * The model can also raise this through the flag_for_agent tool; this is the
 * deterministic floor, so a plain "can someone call me" never depends on the
 * model noticing.
 */
const HANDOFF_PATTERNS: RegExp[] = [
  /\b(call|ring|phone)\s+me\b/i,
  /\bgive me a call\b/i,
  /\b(speak|talk|chat)\s+(to|with)\s+(a|an|the)?\s*(real\s+)?(person|human|agent|someone|somebody)\b/i,
  /\bare you (a )?(real\s+)?(person|human|bot|robot|ai)\b/i,
  /\bis this (a )?(real\s+)?(person|human|bot|robot|ai)\b/i,
  /\bhuman\b/i,
  /\breal person\b/i,
];

export function wantsHuman(text: string | null | undefined, agentName?: string | null): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  for (const re of HANDOFF_PATTERNS) if (re.test(t)) return true;
  // Asked for the agent by name.
  const name = String(agentName ?? "").trim();
  if (name.length >= 3 && new RegExp(`\\b${escapeRe(name.split(/\s+/)[0])}\\b`, "i").test(t)) return true;
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Hot text lead: Mark J — asking about pricing. Open: <link>" */
export function hotAlertSms(opts: {
  leadName?: string | null;
  reason?: string | null;
  link?: string | null;
}): string {
  const who = String(opts.leadName || "").trim() || "A lead";
  const why = String(opts.reason || "").trim();
  const link = String(opts.link || "").trim();
  let s = `Hot text lead: ${who}`;
  if (why) s += ` — ${why.slice(0, 90)}`;
  s += ".";
  if (link) s += ` Open: ${link}`;
  return s;
}

// ------------------------------------------------------------
// Auto-mute
// ------------------------------------------------------------

/**
 * An agent who types a message into a thread has taken it over.
 *
 * The AI mutes itself until they turn it back on, because two of them
 * answering the same person is worse than neither. `system` sends — opt-out
 * confirmations, appointment confirmations — are NOT a takeover: nobody chose
 * those words at the time, and muting on them would silence the AI every time
 * it successfully booked somebody.
 */
export function shouldAutoMute(sentBy: string | null | undefined): boolean {
  return String(sentBy ?? "") === "agent";
}

// ------------------------------------------------------------
// The prompt
// ------------------------------------------------------------

const TONE_LINES: Record<string, string> = {
  professional: "Write in a warm but professional register. No slang, no exclamation marks.",
  friendly: "Write the way a helpful colleague texts: warm, plain, contractions are fine.",
  casual: "Write casually and briefly, the way people actually text. Contractions and sentence fragments are fine.",
};

const LENGTH_LINES: Record<string, string> = {
  brief: "Keep replies to ONE short sentence, two at the absolute most. This is a text message, not an email.",
  medium: "Keep replies to two or three short sentences.",
};

export interface PromptContext {
  aiName?: string | null;
  agentName?: string | null;
  agencyName?: string | null;
  leadName?: string | null;
  leadTimezone?: string | null;
  campaignLabel?: string | null;
  qualification?: Record<string, unknown> | null;
  settings: SmsAiSettings;
}

/**
 * The system prompt.
 *
 * THE COMPLIANCE PARAGRAPH IS NOT STYLE AND MUST NOT BE EDITED FOR TONE. It
 * carries the same rule the voice assistant carries and for the same reason:
 * "never claim to be human when asked directly" is the sentence that keeps a
 * 10DLC campaign and an AI disclosure honest, and this one has carrier review
 * items on record. See docs/ai-assistant-script-v1.md for the voice wording —
 * one persona, two channels.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const s = ctx.settings;
  const aiName = String(ctx.aiName || "").trim();
  const agent = String(ctx.agentName || "").trim();
  const agency = String(ctx.agencyName || "").trim();
  const lead = String(ctx.leadName || "").trim();

  const who = aiName
    ? `You are ${aiName}, an assistant`
    : "You are an assistant";
  const forWhom = agent && agency
    ? ` working with ${agent} at ${agency}.`
    : agent
    ? ` working with ${agent}.`
    : agency
    ? ` at ${agency}.`
    : ".";

  const lines: string[] = [
    `${who}${forWhom} You are answering a text message from a potential client.`,
    "",
    "RULES YOU MAY NOT BREAK:",
    // Identical in substance to the voice assistant's rule.
    "- If anyone asks whether you are a real person, a human, a bot or an AI, answer immediately and plainly that you are an automated assistant. Never claim or imply you are a person.",
    "- If they ask to stop, to be removed, or not to be contacted, do not argue and do not try to keep them. Acknowledge it in one sentence.",
    "- Never guarantee coverage, approval, a rate, or a price. You are not underwriting anything.",
    "- Never state a premium, a payout or a policy term as fact unless it appears verbatim in the agent's own answers below.",
    "- Do not invent facts about the person, their policy or their application.",
    "- If you do not know something, say the agent will confirm it.",
    "",
    "STYLE:",
    `- ${TONE_LINES[s.tone] || TONE_LINES.friendly}`,
    `- ${LENGTH_LINES[s.reply_length] || LENGTH_LINES.brief}`,
    s.emojis
      ? "- At most one emoji, and only where it genuinely fits."
      : "- Do not use emojis.",
    "- Never send a wall of text. Never use markdown, bullet points or headings.",
    "- Do not sign your name on every message; this is a running conversation.",
  ];

  if (lead) lines.push("", `The person you are texting is ${lead}.`);
  if (ctx.campaignLabel) lines.push(`Context: they came in through ${ctx.campaignLabel}.`);
  if (ctx.leadTimezone) lines.push(`Their timezone is ${ctx.leadTimezone}.`);

  const q = ctx.qualification;
  if (q && typeof q === "object") {
    const bits = Object.entries(q)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`);
    if (bits.length) lines.push("", "What is already known about them:", ...bits.map((b) => `- ${b}`));
  }

  const pairs = s.custom_pairs;
  if (pairs.length) {
    lines.push(
      "",
      "THE AGENT'S OWN ANSWERS. These are authoritative — where one covers the question, use it and do not paraphrase it into something weaker:",
      ...pairs.map((p) => `- If they ask about "${p.trigger}": ${p.answer}`),
    );
  }

  lines.push(
    "",
    "TOOLS:",
    `- book_appointment: when they agree to a specific day and time, call this with their exact words. The appointment is a ${s.appointment_minutes}-minute ${s.appointment_label}.`,
    "- flag_for_agent: when they ask for a call, ask for a person, or are clearly ready to buy. Then keep the conversation going warmly — do not go silent.",
  );

  return lines.join("\n");
}

/** What the assistant says while the agent is being fetched. */
export function warmHoldingLine(agentName?: string | null): string {
  const a = String(agentName || "").trim();
  return a
    ? `Let me get ${a} for you — they'll reach out shortly.`
    : "Let me get someone for you — they'll reach out shortly.";
}

// ------------------------------------------------------------
// Reply hygiene
// ------------------------------------------------------------

/**
 * SMS is not a chat window.
 *
 * The model is told to be brief and usually is, but "usually" bills per
 * segment and lands on a consumer's phone. This is the floor: strip markdown
 * artefacts, collapse whitespace, and cut to a hard ceiling on a word boundary.
 */
export const SMS_REPLY_MAX_CHARS = 320;

export function tidyReply(text: string | null | undefined, maxChars = SMS_REPLY_MAX_CHARS): string {
  let t = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

// ------------------------------------------------------------

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}
