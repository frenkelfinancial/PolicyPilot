// ============================================================
// supabase/functions/_shared/statement-ai.ts
//
// The only part of statement ingestion that talks to Anthropic. Two shapes,
// and the difference between them is the whole cost story:
//
//   deriveColumnMapping()  — TABULAR files (CSV/XLSX/XLS). ONE call per sheet,
//                            regardless of row count. The model sees the header
//                            row and a handful of sample rows and returns a
//                            column mapping; statement-core.ts then applies
//                            that mapping to every row deterministically. A
//                            10,000-row statement and a 10-row statement cost
//                            exactly the same. This is still template-free —
//                            the model derives the template per file, we just
//                            do not re-derive it per row.
//
//   extractPdfRows()       — PDFs, where there is no column structure to
//                            derive. The document goes to the model natively
//                            as a `document` content block and rows come back
//                            directly.
//
// Both use Structured Outputs (output_config.format) so a parse never depends
// on model formatting, and both hand their VERBATIM output back to the caller
// so it can be stored in statement_extractions before our normalizer touches
// it. Amounts and dates come back as strings on purpose: the deterministic
// layer owns "(75.00) means minus seventy-five dollars", not the model.
//
// Model: claude-haiku-4-5 — the same extraction tier the carrier-mail pipeline
// pins (_shared/anthropic.ts). Extraction is the cheap tier's job; the
// accuracy work lives in the deterministic layer around it.
//
// Required secret: ANTHROPIC_API_KEY
// ============================================================

import { MAPPING_FIELDS, TXN_TYPES } from "./statement-core.ts";
import type { ColumnMapping, TxnType, SheetPreview } from "./statement-core.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const STATEMENT_MODEL = "claude-haiku-4-5";

const MAPPING_MAX_TOKENS = 2048;
const PDF_MAX_TOKENS = 16000;

/** Anthropic's own ceiling for a base64 document block is 32 MB of request. */
export const PDF_MAX_BYTES = 20 * 1024 * 1024;

export interface AiUsage { inputTokens: number; outputTokens: number; model: string }

export interface MappingResult {
  mapping: ColumnMapping;
  raw: Record<string, unknown>;
  usage: AiUsage;
  confidence: number;
}

export interface PdfRow {
  policy_number: string;
  insured_name: string;
  product: string;
  transaction_type: string;
  amount: string;
  premium: string;
  transaction_date: string;
  producer_code: string;
}

export interface PdfResult {
  carrier: string;
  periodStart: string;
  periodEnd: string;
  rows: PdfRow[];
  raw: Record<string, unknown>;
  usage: AiUsage;
  truncated: boolean;
}

// ------------------------------------------------------------
// Schemas.
//
// Deliberately free of nullable unions: every field is a plain string or
// integer, with "" and -1 as the "not present" values. Structured Outputs
// supports `anyOf`, but a schema with no unions at all is one the model can
// never half-satisfy, and it keeps the compiled-schema cache hit rate high.
// ------------------------------------------------------------

const columnProps: Record<string, unknown> = {};
for (const f of MAPPING_FIELDS) {
  columnProps[f] = {
    type: "integer",
    description: `Zero-based index of the column holding ${f.replace(/_/g, " ")}, or -1 if this sheet has no such column.`,
  };
}

const MAPPING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["columns", "carrier", "period_start", "period_end", "type_map", "confidence", "notes"],
  properties: {
    columns: {
      type: "object",
      additionalProperties: false,
      required: [...MAPPING_FIELDS],
      properties: columnProps,
    },
    carrier: {
      type: "string",
      description: "Insurance carrier this statement is from, if it is stated anywhere. Empty string if unknown.",
    },
    period_start: { type: "string", description: "Statement period start as YYYY-MM-DD, or empty string." },
    period_end: { type: "string", description: "Statement period end as YYYY-MM-DD, or empty string." },
    type_map: {
      type: "array",
      description:
        "One entry per DISTINCT value seen in the transaction-type column, mapping the carrier's own wording to our vocabulary.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "type"],
        properties: {
          value: { type: "string", description: "The value exactly as printed in the sheet." },
          type: { type: "string", enum: TXN_TYPES },
        },
      },
    },
    confidence: { type: "number", description: "0-1: your certainty that this mapping is correct." },
    notes: { type: "string", description: "One short sentence if anything about this sheet is unusual, else empty." },
  },
} as const;

const PDF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["carrier", "period_start", "period_end", "rows"],
  properties: {
    carrier: { type: "string", description: "Carrier name, or empty string if not stated." },
    period_start: { type: "string", description: "YYYY-MM-DD or empty string." },
    period_end: { type: "string", description: "YYYY-MM-DD or empty string." },
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "policy_number", "insured_name", "product", "transaction_type",
          "amount", "premium", "transaction_date", "producer_code",
        ],
        properties: {
          policy_number: { type: "string" },
          insured_name: { type: "string" },
          product: { type: "string" },
          transaction_type: { type: "string", enum: TXN_TYPES },
          amount: {
            type: "string",
            description:
              "The commission amount EXACTLY as printed, including any $ sign, parentheses, trailing minus or CR marker. Do not convert it.",
          },
          premium: { type: "string", description: "Premium exactly as printed, or empty string." },
          transaction_date: { type: "string", description: "Date exactly as printed, or empty string." },
          producer_code: { type: "string", description: "Writing/agent number or NPN on the line, or empty string." },
        },
      },
    },
  },
} as const;

// ------------------------------------------------------------
// Prompts.
// ------------------------------------------------------------

const MAPPING_SYSTEM =
  "You read the header row and a few sample rows of a US life-insurance carrier COMMISSION STATEMENT and " +
  "return which column holds which field. You are producing a mapping that will then be applied to every row " +
  "of the sheet mechanically, so getting a column index wrong silently corrupts thousands of rows — when a " +
  "column is genuinely absent or you are not sure, return -1 for it rather than guessing. " +
  "`amount` is the COMMISSION paid to the agent, not the policy premium; if the sheet has both, `amount` is " +
  "the commission column and `premium` is the premium column. " +
  "Column indexes are zero-based and refer to the positions shown in the header list. " +
  "For `type_map`, list every distinct value you can see in the transaction-type column and map each to one " +
  "of the allowed types; a value meaning money taken back from the agent (chargeback, reversal, clawback, " +
  "recovery, refund) is `chargeback`. Do not invent values you have not seen. " +
  "Output ONLY JSON matching the schema.";

const PDF_SYSTEM =
  "You read a US life-insurance carrier COMMISSION STATEMENT (PDF) and return one object per commission " +
  "line item. Return EVERY line item you can see, in the order they appear. Do not return summary, subtotal, " +
  "total or page-footer lines. " +
  "Reproduce `amount`, `premium` and `transaction_date` EXACTLY as printed — keep the dollar sign, the " +
  "parentheses, a trailing minus, a CR marker, and the carrier's own date format. Converting them is not your " +
  "job and doing it loses information. " +
  "`amount` is the commission paid to the agent, not the policy premium. " +
  "A line meaning money taken back from the agent (chargeback, reversal, clawback, recovery, refund) is " +
  "`chargeback`. Use empty string for anything the line does not state. Do not invent policy numbers or names. " +
  "Output ONLY JSON matching the schema.";

// ------------------------------------------------------------
// Transport.
// ------------------------------------------------------------

interface AnthropicCall {
  apiKey: string;
  system: string;
  content: unknown;
  schema: unknown;
  maxTokens: number;
}

async function callAnthropic(opts: AnthropicCall): Promise<{ parsed: Record<string, unknown>; usage: AiUsage; truncated: boolean }> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: STATEMENT_MODEL,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.content }],
      output_config: { format: { type: "json_schema", schema: opts.schema } },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.type === "error") {
    throw new Error(`anthropic_error: ${data?.error?.message ?? res.status}`);
  }
  if (data.stop_reason === "refusal") throw new Error("anthropic_refusal");

  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`anthropic_bad_json: ${String(text).slice(0, 200)}`);
  }

  return {
    parsed,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      model: STATEMENT_MODEL,
    },
    truncated: data.stop_reason === "max_tokens",
  };
}

// ------------------------------------------------------------
// 1. Column mapping — one call per sheet, whatever its size.
// ------------------------------------------------------------

/**
 * Turn the model's answer into a ColumnMapping.
 *
 * Exported and pure so the coercion — which is where a bad index would do its
 * damage — is unit-testable without a network call.
 */
export function coerceMapping(raw: Record<string, unknown>, headerCount: number): { mapping: ColumnMapping; confidence: number } {
  const columns: ColumnMapping["columns"] = {};
  const rawCols = (raw?.columns ?? {}) as Record<string, unknown>;
  for (const f of MAPPING_FIELDS) {
    const v = Number(rawCols[f]);
    // A column index outside the sheet is worse than no mapping at all: it
    // would read blank for every row and look like clean, empty data.
    if (Number.isInteger(v) && v >= 0 && (headerCount === 0 || v < Math.max(headerCount, 1) * 4)) {
      columns[f] = v;
    }
  }

  const typeMap: Record<string, TxnType> = {};
  const entries = Array.isArray(raw?.type_map) ? raw.type_map as { value?: unknown; type?: unknown }[] : [];
  for (const e of entries) {
    const value = String(e?.value ?? "");
    const type = String(e?.type ?? "") as TxnType;
    if (value === "" || !TXN_TYPES.includes(type)) continue;
    typeMap[value] = type;
    typeMap[value.toLowerCase()] = type;
  }

  const str = (k: string) => {
    const v = raw?.[k];
    const s = typeof v === "string" ? v.trim() : "";
    return s === "" ? null : s;
  };

  const conf = Number(raw?.confidence);
  return {
    mapping: {
      columns,
      carrier: str("carrier"),
      periodStart: str("period_start"),
      periodEnd: str("period_end"),
      typeMap,
      notes: str("notes"),
    },
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
  };
}

export async function deriveColumnMapping(opts: {
  apiKey: string;
  preview: SheetPreview;
  previewText: string;
  filename: string;
  carrierHint?: string | null;
}): Promise<MappingResult> {
  const user =
    `File: ${opts.filename}\n` +
    (opts.carrierHint ? `Carrier suggested by the file name or letterhead: ${opts.carrierHint}\n` : "") +
    `\n${opts.previewText}\n`;

  const { parsed, usage } = await callAnthropic({
    apiKey: opts.apiKey,
    system: MAPPING_SYSTEM,
    content: user,
    schema: MAPPING_SCHEMA,
    maxTokens: MAPPING_MAX_TOKENS,
  });

  const { mapping, confidence } = coerceMapping(parsed, opts.preview.headers.length);
  if (!mapping.carrier && opts.carrierHint) mapping.carrier = opts.carrierHint;

  return { mapping, raw: parsed, usage, confidence };
}

// ------------------------------------------------------------
// 2. PDF rows — the model reads the document itself.
// ------------------------------------------------------------

/** Base64 for a byte array, chunked so a large PDF cannot blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function extractPdfRows(opts: {
  apiKey: string;
  bytes: Uint8Array;
  filename: string;
  carrierHint?: string | null;
}): Promise<PdfResult> {
  if (opts.bytes.length > PDF_MAX_BYTES) {
    throw new Error("pdf_too_large_for_model");
  }

  const content = [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(opts.bytes) },
    },
    {
      type: "text",
      text:
        `File: ${opts.filename}\n` +
        (opts.carrierHint ? `Carrier suggested by the file name: ${opts.carrierHint}\n` : "") +
        `Return every commission line item in this statement.`,
    },
  ];

  const { parsed, usage, truncated } = await callAnthropic({
    apiKey: opts.apiKey,
    system: PDF_SYSTEM,
    content,
    schema: PDF_SCHEMA,
    maxTokens: PDF_MAX_TOKENS,
  });

  const rows = Array.isArray(parsed?.rows) ? parsed.rows as PdfRow[] : [];
  return {
    carrier: String(parsed?.carrier ?? "").trim() || (opts.carrierHint ?? ""),
    periodStart: String(parsed?.period_start ?? "").trim(),
    periodEnd: String(parsed?.period_end ?? "").trim(),
    rows,
    raw: parsed,
    usage,
    truncated,
  };
}
