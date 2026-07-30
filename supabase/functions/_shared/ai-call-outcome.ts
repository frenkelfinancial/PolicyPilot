// ============================================================
// ai-call-outcome.ts
// Reading an AI call's ENDING out of whatever Telnyx sends back.
//
// Dependency-free on purpose (no supabase, no Deno globals) so it runs under
// BOTH `node --test` (ai-call-outcome.test.ts) and the Deno edge runtime
// (ai-call-webhook). Same arrangement as ai-call-billing.ts.
//
// ---- Why this file exists ------------------------------------------------
//
// Phase 1 assumed the assistant's end-of-call JSON would arrive intact. It
// does not. Telnyx's `call.conversation_insights.generated` event carries:
//
//   { results: [ { insight_id: "…", result: "<a prose paragraph>" } ], … }
//
// …with no `outcome` key anywhere, because the account's only configured
// insight was the stock "Summary" one. The old extractOutcomeObject() looked
// for an object literally containing `outcome`, found nothing, and every
// single completed call landed `outcome = 'error'` with a null summary — six
// production rows' worth, all of them calls that had gone perfectly well.
// The qualification data the assistant had actually gathered was discarded.
//
// The real fix is upstream: a custom insight with a strict `json_schema`, so
// Telnyx returns JSON instead of prose (see docs/ai-assistant-script-v1.md
// § "Structured insights"). This module is the belt to that pair of braces,
// and it degrades in four documented steps:
//
//   1. JSON        — the whole result parses as an object. The happy path
//                    once the structured insight is live.
//   2. embedded    — a {...} block inside prose (an LLM that wrapped its JSON
//                    in "Here's the summary:"). Brace-balanced, not regex —
//                    a greedy regex spanning two objects parses as neither.
//   3. keywords    — map the prose itself to an outcome. Coarse, but "the
//                    caller asked to be removed from the list" is not
//                    something to shrug at because the JSON was missing.
//   4. prose only  — keep the paragraph as the summary and let the caller
//                    derive the outcome from call-flow facts it already has
//                    (did it answer, did AMD say machine, did it transfer).
//
// A call that completed normally must NEVER end up 'error'. `error` means WE
// broke — the assistant failed to attach, a secret was missing — and it is
// also what suppresses the wallet debit. Using it as "we couldn't classify
// this" conflates a bad call with a bad classifier and, worse, makes the
// classifier's failure look like the agent's.
// ============================================================

import { type AiCallOutcome, normalizeOutcome } from "./ai-call-billing.ts";

/**
 * The structured object the assistant is asked to produce, after coercion.
 * Every field is a string (or null) because it is spoken data — "fifty-eight
 * or so" is a real answer to the age question and must survive being stored.
 */
export interface Qualification {
  outcome: string | null;
  age: string | null;
  coverage_interest: string | null;
  budget_text: string | null;
  best_callback_text: string | null;
  notes: string | null;
  summary: string | null;
}

export const QUALIFICATION_KEYS: Array<keyof Qualification> = [
  "outcome",
  "age",
  "coverage_interest",
  "budget_text",
  "best_callback_text",
  "notes",
  "summary",
];

/**
 * Older key names the v1 script asked for, plus the shapes an LLM reaches for
 * when it half-remembers the schema. Mapped rather than dropped: a call where
 * the assistant said `age_band: "50-59"` gathered the age, and throwing that
 * away because the key moved would be losing the only thing the call was for.
 */
const KEY_ALIASES: Record<string, keyof Qualification> = {
  age_band: "age",
  age_range: "age",
  coverage_type: "coverage_interest",
  coverage: "coverage_interest",
  product: "coverage_interest",
  budget: "budget_text",
  monthly_budget: "budget_text",
  callback_window: "best_callback_text",
  callback: "best_callback_text",
  best_time: "best_callback_text",
  best_callback: "best_callback_text",
  note: "notes",
  detail: "notes",
  details: "notes",
  disposition: "outcome",
  result: "outcome",
};

/** How an outcome was arrived at. Recorded in the trace so a wrong tag is diagnosable. */
export type OutcomeMethod =
  | "json"          // the result parsed as JSON outright
  | "embedded_json" // a {...} block lifted out of prose
  | "keywords"      // the prose was keyword-mapped
  | "prose_only"    // nothing but a summary could be salvaged
  | "none";         // no insight content at all

export interface ParsedInsight {
  qualification: Qualification | null;
  summary: string | null;
  outcome: AiCallOutcome | null;
  method: OutcomeMethod;
}

const str = (v: unknown): string | null => {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
};

/**
 * Pull the first BALANCED `{...}` object out of a string.
 *
 * Deliberately not a regex. The previous implementation used
 * `/\{[\s\S]*"outcome"[\s\S]*\}/` — greedy, so given prose containing two
 * separate JSON objects it matched from the first `{` to the LAST `}` and
 * produced a string that is not valid JSON at all. This walks the braces,
 * skipping anything inside a string literal (and honouring backslash escapes,
 * so a `"}"` inside a value cannot close the object early), and tries each
 * candidate opening brace until one parses.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch { /* try the next opening brace */ }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Coerce an arbitrary parsed object into a Qualification.
 *
 * Returns null for an object that carries none of the fields we asked for —
 * an insight that happened to contain JSON about something else is not a
 * qualification, and treating it as one would write "Poor" into the age field
 * the first time a managed insight (Agent Instruction Following, User
 * Satisfaction — both return `{score, reason}`) shares the results array.
 */
export function coerceQualification(raw: unknown): Qualification | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;

  const out: Qualification = {
    outcome: null, age: null, coverage_interest: null,
    budget_text: null, best_callback_text: null, notes: null, summary: null,
  };

  let hits = 0;
  for (const [k, v] of Object.entries(src)) {
    const key = (QUALIFICATION_KEYS as string[]).includes(k)
      ? (k as keyof Qualification)
      : KEY_ALIASES[k.toLowerCase()];
    if (!key) continue;
    const s = str(v);
    if (s === null) continue;
    // First writer wins, so a canonical key is never clobbered by an alias.
    if (out[key] === null) { out[key] = s; hits++; }
  }

  return hits > 0 ? out : null;
}

/**
 * Map an English sentence to an outcome.
 *
 * Ordered by consequence, not by likelihood: an opt-out that also mentions a
 * callback is an opt-out. Every pattern is anchored on the words a summarizer
 * actually writes ("asked to be removed", "not interested"), not on the words
 * the person said, because this reads a THIRD-PARTY summary of the call.
 *
 * Returns null rather than guessing. A wrong tag here is worse than no tag:
 * the caller has real call-flow facts to fall back on.
 */
export function keywordOutcome(prose: string): AiCallOutcome | null {
  if (typeof prose !== "string" || !prose.trim()) return null;
  const t = prose.toLowerCase();

  const has = (...res: RegExp[]) => res.some((r) => r.test(t));

  // 1. Opt-out beats everything. Also the only one that writes to a
  //    suppression list, so a false positive costs us a lead and a false
  //    negative costs a TCPA claim — the asymmetry is the point.
  if (has(
    /do not call|do-not-call|\bdnc\b/,
    /(take|took|remove|removed|taken)\s+(me|them|him|her|the (caller|number|lead))?\s*(off|from)?\s*(the|your|our)?\s*(list|calling list)/,
    /asked (to be|not to be)?\s*(removed|taken off)/,
    /requested (removal|to be removed|no further contact)/,
    /stop calling/,
  )) return "dnc_request";

  // 2. An appointment that got booked is a stronger fact than a transfer that
  //    was merely attempted, so it is read first.
  if (has(
    /appointment (was )?(booked|scheduled|set)/,
    /(booked|scheduled|set up) (an|the|a) (appointment|call ?back|meeting|time)/,
    /agreed to (a|an) (appointment|meeting)/,
  )) return "appointment_booked";

  if (has(
    /(was |were )?(transferred|connected|bridged) (to|with) (the |a |their )?(agent|licensed agent|producer)/,
    /warm transfer (completed|succeeded)/,
  )) return "transferred";

  if (has(
    /call ?back (was )?(requested|asked for)/,
    /asked (for|to be called)( a)? (call ?back|back)/,
    /requested (a )?call ?back/,
  )) return "callback_requested";

  if (has(
    /not interested/,
    /(declined|refused|turned down) (the )?(offer|coverage|policy)/,
    /already (has|have|had) coverage/,
    /no longer (looking|interested|in the market)/,
  )) return "not_interested";

  if (has(
    /(reached|went to|hit|left at) (the )?voice ?mail/,
    /answering machine/,
    /voice ?mail (greeting|system)/,
  )) return "voicemail";

  if (has(
    /(no|never) (answer|answered)/,
    /nobody (picked up|answered)/,
    /did not (pick up|answer)/,
  )) return "no_answer";

  // 3. Qualified last: "interested" appears inside "not interested", and the
  //    negatives above have already claimed those sentences.
  if (has(
    /\bqualified\b/,
    /(is|was|seemed|remains) interested/,
    /expressed interest/,
    /wants (more information|a quote|coverage)/,
  )) return "qualified";

  return null;
}

/**
 * Read the assistant's ending out of a Telnyx insights event payload.
 *
 * Accepts the whole `data.payload`. Walks `results[]` (the real shape:
 * `[{ insight_id, result }]`) and also the legacy single-object locations the
 * Phase 1 code guessed at, so a payload-shape change on Telnyx's side degrades
 * instead of going blank.
 *
 * `preferInsightId`, when given, makes that insight's result the qualification
 * candidate ahead of the others — the structured insight wins over the prose
 * Summary one even though both arrive in the same array.
 */
export function parseInsightPayload(
  payload: Record<string, unknown>,
  preferInsightId?: string | null,
): ParsedInsight {
  const empty: ParsedInsight = { qualification: null, summary: null, outcome: null, method: "none" };
  if (!payload || typeof payload !== "object") return empty;

  // ---- Collect every candidate result, best-first --------------------------
  type Candidate = { insightId: string | null; value: unknown };
  const candidates: Candidate[] = [];

  const results = payload.results;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        candidates.push({ insightId: str(o.insight_id), value: o.result ?? o.value ?? o.output });
      } else {
        candidates.push({ insightId: null, value: r });
      }
    }
    if (preferInsightId) {
      candidates.sort((a, b) =>
        (b.insightId === preferInsightId ? 1 : 0) - (a.insightId === preferInsightId ? 1 : 0));
    }
  }
  // Legacy / defensive locations. Harmless when absent.
  for (const k of ["insights", "conversation_insights", "metadata", "result", "summary"]) {
    const v = payload[k];
    if (v != null && !Array.isArray(v)) candidates.push({ insightId: null, value: v });
  }

  if (candidates.length === 0) return empty;

  let qualification: Qualification | null = null;
  let method: OutcomeMethod = "none";
  let summary: string | null = null;
  const proseParts: string[] = [];

  for (const c of candidates) {
    const v = c.value;

    // (a) an object already, or a string that IS json
    let obj: Record<string, unknown> | null = null;
    let via: OutcomeMethod = "json";

    if (v && typeof v === "object" && !Array.isArray(v)) {
      obj = v as Record<string, unknown>;
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      try {
        const p = JSON.parse(trimmed);
        if (p && typeof p === "object" && !Array.isArray(p)) obj = p as Record<string, unknown>;
      } catch { /* not JSON — try (b) */ }
      // (b) a {...} block inside prose
      if (!obj) {
        const embedded = extractJsonObject(trimmed);
        if (embedded) { obj = embedded; via = "embedded_json"; }
      }
      if (trimmed) proseParts.push(trimmed);
    }

    if (obj && !qualification) {
      const q = coerceQualification(obj);
      if (q) { qualification = q; method = via; }
    }
  }

  // The prose is worth keeping whether or not the JSON showed up: the stock
  // Summary insight writes a genuinely useful paragraph, and a structured
  // insight with an empty `summary` field should still get one.
  const prose = proseParts.find((p) => p.length > 0 && !p.startsWith("{")) ?? null;

  if (qualification) {
    summary = qualification.summary ?? prose;
    // (c) the object arrived but its outcome field was blank or unknown.
    const fromField = qualification.outcome
      ? normalizeOutcome(qualification.outcome, "in_progress")
      : "in_progress";
    let outcome: AiCallOutcome | null = fromField === "in_progress" ? null : fromField;
    if (!outcome && summary) {
      outcome = keywordOutcome(summary);
      if (outcome) method = "keywords";
    }
    return { qualification, summary, outcome, method };
  }

  // (c)/(d) no usable object at all.
  if (prose) {
    const outcome = keywordOutcome(prose);
    return {
      qualification: null,
      summary: prose,
      outcome,
      method: outcome ? "keywords" : "prose_only",
    };
  }

  return empty;
}

/**
 * Facts the WEBHOOK already knows by the time a call finalizes, independent of
 * anything the assistant said. This is step (d): the last-resort derivation.
 */
export interface CallFlowFacts {
  /** ai_calls.answered_at was stamped — the lead picked up. */
  answered: boolean;
  /** This webhook's own failure paths wrote ai_calls.error_detail. */
  ourFault: boolean;
  /** AMD returned a machine verdict. */
  machineDetected?: boolean;
  /** A suppression row was written for this call. */
  dncRequested?: boolean;
  /** Where the warm transfer got to, if one was attempted. */
  transferStatus?: string | null;
  /** An appointment row was created on this call. */
  appointmentBooked?: boolean;
}

/**
 * The outcome a call gets when nothing classified it.
 *
 * `error` is reserved for OUR failures. Everything else that reached a person
 * is `completed`: a real conversation happened, the agent is billed for it,
 * and the row says so honestly rather than crying error at its own classifier.
 * A call that never answered is `no_answer`, which is a fact, not a guess.
 */
export function outcomeFromCallFlow(facts: CallFlowFacts): AiCallOutcome {
  if (facts.ourFault) return "error";
  if (facts.dncRequested) return "dnc_request";
  if (facts.machineDetected) return "voicemail";
  if (facts.appointmentBooked) return "appointment_booked";
  if (facts.transferStatus === "bridged") return "transferred";
  if (!facts.answered) return "no_answer";
  return "completed";
}

/**
 * Outcomes that, once written, are not overwritten by a later or vaguer
 * signal. A hangup event and an insights event race by design (insights
 * arrive ~8s AFTER the call ends), so finalize must not downgrade a
 * `dnc_request` to `completed` just because it ran second.
 */
export const TERMINAL_OUTCOMES: readonly AiCallOutcome[] = [
  "voicemail", "busy", "not_interested", "qualified", "dnc_request",
  "no_answer", "appointment_booked", "transferred", "callback_requested",
];

/**
 * Should `next` replace `current` on the ai_calls row?
 *
 * The rules, in order:
 *   • never replace anything with a non-answer (null / in_progress);
 *   • a terminal outcome may replace a non-terminal one (`error`,
 *     `completed`, `in_progress`) — this is what lets the late insights event
 *     correct a call that finalize had already written off;
 *   • a terminal outcome NEVER replaces another terminal one. Two terminal
 *     tags means two signals disagreed, and the earlier one saw the call.
 */
export function shouldReplaceOutcome(
  current: string | null | undefined,
  next: AiCallOutcome | null,
): boolean {
  if (!next || next === "in_progress") return false;
  if (!current || current === "in_progress" || current === "error" || current === "completed") return true;
  return !(TERMINAL_OUTCOMES as string[]).includes(current);
}
