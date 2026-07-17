// ============================================================
// supabase/functions/_shared/anthropic.ts
//
// Minimal Claude Messages API client for the extraction step. Pinned to
// claude-haiku-4-5 (cheapest tier — $1/$5 per MTok) and used ONLY to turn a
// pre-trimmed carrier email into structured JSON. No thinking/effort params
// (unsupported on Haiku 4.5). Structured Outputs (output_config.format) forces
// schema-valid JSON so parsing never depends on model formatting.
//
// Cost controls live upstream (the deterministic classifier keeps non-carrier
// mail away entirely; the cleaner trims each body first). Prompt caching is
// deliberately NOT used: Haiku 4.5's minimum cacheable prefix is ~4096 tokens
// and our stable prompt is far shorter — caching wouldn't trigger and padding
// to reach it would cost more than it saves.
//
// Kept as a thin, pure-ish call so commission parses can later be moved to the
// Batch API (50% discount) without touching callers.
//
// Required secret: ANTHROPIC_API_KEY
// ============================================================

import { schemaFor } from "./email/schemas.ts";
import type { SchemaCategory } from "./email/schemas.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5"; // do NOT change tier — extraction only
const MAX_TOKENS = 2048; // headroom for multi-policy digests

const SYSTEM =
  "You extract structured data from a US life-insurance carrier email into JSON for an agent's CRM. " +
  "Decipher carrier shorthand and codes into plain English in the `summary` field " +
  "(for example 'BK DRFT RTN NSF' means bank draft returned for insufficient funds). " +
  "Each summary is 1-3 sentences and MUST lead with the client's full name when it appears anywhere " +
  "in the email (subject, body, or greeting) — never write a nameless summary like 'Payment issued' " +
  "when a name is available; write 'Jane Smith's bank draft was returned for insufficient funds; the " +
  "carrier will re-attempt on 07/21 and the policy lapses if it fails again.' Include the specifics an " +
  "agent needs to act: what happened, dollar amounts, dates, the reason, and any deadline or next step " +
  "stated in the email. Do not invent details that are not in the email. " +
  "Output ONLY JSON matching the schema — no prose, no markdown. Use null for anything not present. " +
  "`confidence` is 0-1: your certainty that the extraction is correct.";

export interface ExtractResult {
  parsed: Record<string, unknown>;
  category: SchemaCategory;
  inputTokens: number;
  outputTokens: number;
}

export async function extractFields(opts: {
  apiKey: string;
  emailType: string;
  carrier: string;
  subject: string;
  text: string;
}): Promise<ExtractResult> {
  const { schema, hint, category } = schemaFor(opts.emailType);

  const user =
    `Carrier: ${opts.carrier}\n` +
    `Email type: ${opts.emailType}\n` +
    `${hint}\n` +
    `Subject: ${opts.subject}\n\n` +
    `Body:\n${opts.text}`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema } },
    }),
  });

  const data = await res.json();
  if (!res.ok || data.type === "error") {
    throw new Error(`anthropic_error: ${data?.error?.message ?? res.status}`);
  }
  if (data.stop_reason === "refusal") throw new Error("anthropic_refusal");

  const jsonText = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`anthropic_bad_json: ${jsonText.slice(0, 200)}`);
  }

  return {
    parsed,
    category,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}
