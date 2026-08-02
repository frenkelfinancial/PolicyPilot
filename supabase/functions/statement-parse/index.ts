// ============================================================
// supabase/functions/statement-parse/index.ts
//
// Step 2 of Back Office ingestion: the worker that walks a queued statement
// through parsing -> persisting -> matching -> ingested, writing the state to
// the row as it goes so the UI's counters are reading real progress rather
// than an animation.
//
// Cost shape (this is the whole reason the split with statement-core.ts
// exists): a TABULAR statement costs exactly ONE Anthropic call per sheet no
// matter how many rows it has — the model derives a column mapping from a
// preview and the mapping is then applied to every row deterministically. Only
// PDFs, which have no column structure to derive, are read row by row by the
// model.
//
// Nothing is ever discarded:
//   * the raw bytes were stored by statement-upload before this ran;
//   * the model's verbatim answer is written to statement_extractions BEFORE
//     our normalizer touches it;
//   * a row that cannot be matched to a policy is stored with
//     review_status='needs_review' and a plain-English reason, never dropped.
//
// Re-running is safe. `commission_rows` carries UNIQUE (agent_id, dedupe_key),
// so a second pass over the same statement inserts nothing new, and a failed
// statement can be retried from the UI as many times as it takes — as long as
// the lines still fingerprint the same. `replace: true` is for when they do
// not: see the block on it below, and docs/back-office-ingestion.md.
//
// Callers: the browser with a user JWT (scoped to that agent), or the service
// role for an unattended sweep. verify_jwt stays TRUE — the service-role key
// is itself a valid Supabase JWT — so this function is deliberately ABSENT
// from supabase/config.toml.
//
// Required secret: ANTHROPIC_API_KEY
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  readXlsx,
  readXls,
  readCsvGrid,
  previewSheet,
  previewToText,
  applyMapping,
  buildDedupeKeys,
  matchRowToPolicy,
  parseDateISO,
  planStatementStatusChanges,
  normalizePdfRows,
  sniffCarrier,
  carryStatementHandWork,
  MAX_ROWS_PER_STATEMENT,
} from "../_shared/statement-core.ts";
import type {
  ExistingRowFacts, HandWorkCarry, NormalizedRow, PolicyCandidate, Sheet,
} from "../_shared/statement-core.ts";
import { deriveColumnMapping, extractPdfRows } from "../_shared/statement-ai.ts";

const STATEMENTS_PER_RUN = 3;   // wall-clock guard, not a capability limit
const ROW_INSERT_BATCH = 500;
const SHEET_MIN_ROWS = 1;       // a sheet with no data rows costs no API call

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * buildDedupeKeys wants a synchronous hash so the core stays pure. Web Crypto
 * is async, so keys are hashed here and handed in — the ordinal logic (the
 * part that matters) still lives in, and is tested in, the core.
 */
async function hashKeys(rows: NormalizedRow[]): Promise<string[]> {
  const plain = buildDedupeKeys(rows, (s) => s); // identity hash -> the raw key text
  return await Promise.all(plain.map(sha256Hex));
}

const nowIso = () => new Date().toISOString();

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Scope: a user's JWT confines the sweep to their own statements; the
  // service role processes the oldest queued work for everyone (cron).
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  let scopeAgentId: string | null = null;
  const { data: { user } } = await sb.auth.getUser(token);
  if (user) scopeAgentId = user.id;
  else if (!token || token !== SERVICE_KEY) return json({ error: "unauthorized" }, 401);

  let body: { statement_id?: string; retry?: boolean; replace?: boolean } = {};
  try { body = await req.json(); } catch { /* no body is fine */ }

  // ------------------------------------------------------------
  // 🔴 RE-READ REPLACES. It used to append, and the reason is the dedupe key.
  //
  // `commission_rows` is UNIQUE (agent_id, dedupe_key) and the key carries the
  // transaction DATE, the amount and an occurrence ordinal. The upsert below
  // uses ignoreDuplicates, so re-reading a statement whose lines still
  // fingerprint identically writes nothing — which is what made re-reading
  // look safe. The moment a parser fix changes a date (FIX2 turned nine nulls
  // into real July dates) every fingerprint changes, nothing collides, and the
  // second read lands a complete second set of rows BESIDE the first. The
  // owner's $262.45 statement would have re-read to $524.90.
  //
  // The key is right and is not changing — the ordinal is what keeps a carrier's
  // two legitimately identical lines from collapsing into one. What was missing
  // is this: a re-read that puts the statement's rows back the way the parse
  // now reads them, rather than adding to them.
  //
  // Only ever for ONE named statement. A sweep must not silently rewrite
  // everybody's book.
  // ------------------------------------------------------------
  const replaceMode = !!(body.replace && body.statement_id);

  // ------------------------------------------------------------
  // Pick up work.
  //
  // A sweep only ever picks up queued work (and, with `retry`, previously
  // failed work). Naming ONE statement explicitly is different: that is an
  // operator saying "read this one again", so it is allowed whatever state the
  // statement is in — re-reading an already-ingested statement writes no
  // duplicate rows (UNIQUE (agent_id, dedupe_key)) and is the only way to pick
  // up a policy that was added to the tracker after the statement arrived.
  // ------------------------------------------------------------
  const statuses = body.statement_id
    ? ["queued", "parsing", "persisting", "matching", "ingested", "failed"]
    : (body.retry ? ["queued", "failed"] : ["queued"]);

  let q = sb
    .from("commission_statements")
    .select("id, agent_id, filename, file_kind, carrier, attempts, status")
    .in("status", statuses)
    .neq("file_kind", "zip")
    .order("created_at", { ascending: true })
    .limit(STATEMENTS_PER_RUN);
  if (scopeAgentId) q = q.eq("agent_id", scopeAgentId);
  if (body.statement_id) q = q.eq("id", body.statement_id);

  const { data: pending, error: pendErr } = await q;
  if (pendErr) return json({ error: "queue_read_failed", detail: pendErr.message }, 500);
  if (!pending || pending.length === 0) return json({ ok: true, processed: 0, results: [] });

  const results: Record<string, unknown>[] = [];

  for (const st of pending) {
    const setStatus = async (status: string, extra: Record<string, unknown> = {}) => {
      await sb.from("commission_statements").update({ status, ...extra }).eq("id", st.id);
    };
    const fail = async (message: string) => {
      await setStatus("failed", { error: message.slice(0, 500), status_detail: null });
      results.push({ id: st.id, filename: st.filename, status: "failed", error: message });
    };

    try {
      await setStatus("parsing", { attempts: (st.attempts ?? 0) + 1, error: null, status_detail: "Reading the file" });

      // ---- replace: photograph the rows before anything moves ----
      //
      // Taken FIRST, and as whole rows rather than just the hand-work columns,
      // because this snapshot does two jobs: it is what the carry-over reads,
      // and it is what goes back if the insert below fails. Ordered by
      // row_index — the statement's own line order — because the carry-over is
      // positional within a group of identical lines and a different order
      // would hand one twin's approval to the other.
      let priorRows: Record<string, unknown>[] | null = null;
      if (replaceMode) {
        const { data: prior, error: priorErr } = await sb
          .from("commission_rows").select("*")
          .eq("statement_id", st.id).eq("agent_id", st.agent_id)
          .order("row_index", { ascending: true });
        if (priorErr) { await fail(`The existing lines could not be read back: ${priorErr.message}`); continue; }
        priorRows = prior ?? [];
      }

      // ---- bytes ----
      const fileRes = await sb
        .from("statement_files").select("content").eq("statement_id", st.id).maybeSingle();
      if (fileRes.error || !fileRes.data?.content) {
        await fail("The stored file could not be read back.");
        continue;
      }
      const bytes = hexToBytes(String(fileRes.data.content));

      const carrierHint = st.carrier || sniffCarrier(st.filename) || null;
      let rows: NormalizedRow[] = [];
      let inputTokens = 0, outputTokens = 0, model: string | null = null;
      let detectedCarrier: string | null = carrierHint;
      let periodStart: string | null = null;
      let periodEnd: string | null = null;

      // ---- parse ----
      if (st.file_kind === "pdf") {
        await setStatus("parsing", { status_detail: "Reading the PDF" });
        const pdf = await extractPdfRows({
          apiKey: ANTHROPIC_API_KEY, bytes, filename: st.filename, carrierHint,
        });
        inputTokens += pdf.usage.inputTokens;
        outputTokens += pdf.usage.outputTokens;
        model = pdf.usage.model;
        detectedCarrier = pdf.carrier || carrierHint;
        periodStart = parseDateISO(pdf.periodStart);
        periodEnd = parseDateISO(pdf.periodEnd);

        await sb.from("statement_extractions").insert({
          statement_id: st.id, agent_id: st.agent_id, kind: "pdf_rows",
          model: pdf.usage.model, raw_output: pdf.raw,
          prompt_excerpt: `PDF ${st.filename} (${bytes.length} bytes)`,
          input_tokens: pdf.usage.inputTokens, output_tokens: pdf.usage.outputTokens,
        });

        if (pdf.truncated) {
          await fail(
            "This PDF has more line items than one pass can read. The extraction so far is saved — " +
            "please upload the statement as CSV or Excel, or split it by date range.",
          );
          continue;
        }

        // The projection lives in statement-core so the tests execute the code
        // that ships. It owns the date chain (transaction -> paid -> effective
        // -> due -> period end, the first three matching the tabular path byte
        // for byte) and the type refinement that lets the carrier's own
        // printed heading correct a first-year line the model called a
        // renewal. A null transaction_date is not "undated" downstream — it
        // removes the row from the trend chart, the persistency windows and
        // the debt drill-down while the totals above them still count it.
        rows = normalizePdfRows(pdf.rows, {
          carrier: detectedCarrier,
          statementDate: pdf.statementDate,
          periodStart,
          periodEnd,
        });
      } else {
        // ---- tabular: one AI call per sheet, mapping applied in code ----
        let sheets: Sheet[];
        if (st.file_kind === "xlsx") sheets = readXlsx(bytes);
        else if (st.file_kind === "xls") sheets = readXls(bytes);
        else sheets = [{ name: st.filename, rows: readCsvGrid(new TextDecoder().decode(bytes)) }];

        if (sheets.length === 0) { await fail("The file holds no readable sheet."); continue; }

        for (const sheet of sheets) {
          const preview = previewSheet(sheet);
          if (preview.totalRows < SHEET_MIN_ROWS || preview.headers.length === 0) continue;

          await setStatus("parsing", { status_detail: `Reading “${sheet.name}”` });
          const mapped = await deriveColumnMapping({
            apiKey: ANTHROPIC_API_KEY,
            preview,
            previewText: previewToText(preview),
            filename: st.filename,
            carrierHint,
          });
          inputTokens += mapped.usage.inputTokens;
          outputTokens += mapped.usage.outputTokens;
          model = mapped.usage.model;

          await sb.from("statement_extractions").insert({
            statement_id: st.id, agent_id: st.agent_id, kind: "column_mapping",
            sheet_name: sheet.name, model: mapped.usage.model, raw_output: mapped.raw,
            prompt_excerpt: previewToText(preview).slice(0, 4000),
            input_tokens: mapped.usage.inputTokens, output_tokens: mapped.usage.outputTokens,
          });

          if (mapped.mapping.columns.amount === undefined) {
            // Without an amount column there is no commission to record. Say
            // so rather than writing a sheet full of zeroes.
            continue;
          }

          detectedCarrier = detectedCarrier || mapped.mapping.carrier || null;
          periodStart = periodStart || (mapped.mapping.periodStart ? parseDateISO(mapped.mapping.periodStart) : null);
          periodEnd = periodEnd || (mapped.mapping.periodEnd ? parseDateISO(mapped.mapping.periodEnd) : null);

          const sheetRows = applyMapping(sheet, preview, {
            ...mapped.mapping,
            periodStart: mapped.mapping.periodStart ?? periodStart,
            periodEnd: mapped.mapping.periodEnd ?? periodEnd,
          });
          rows.push(...sheetRows.map((r, i) => ({ ...r, rowIndex: rows.length + i })));
          if (rows.length >= MAX_ROWS_PER_STATEMENT) break;
        }
      }

      if (rows.length === 0) {
        await fail(
          "No commission lines were found in this file. If it is a summary or a cover letter rather than a " +
          "statement, that is expected.",
        );
        continue;
      }
      if (rows.length > MAX_ROWS_PER_STATEMENT) rows = rows.slice(0, MAX_ROWS_PER_STATEMENT);

      // ---- persist ----
      await setStatus("persisting", { status_detail: `Saving ${rows.length} lines` });
      const keys = await hashKeys(rows);

      // ---- match ----
      const { data: policyRows } = await sb
        .from("policies").select("id, client_id, data").eq("agent_id", st.agent_id);
      const candidates: PolicyCandidate[] = (policyRows ?? []).map((p) => {
        const d = (p.data ?? {}) as Record<string, unknown>;
        return {
          id: p.id as string,
          policyNumber: (d.policyNumber as string) ?? null,
          clientName: (d.client as string) ?? null,
          carrier: (d.carrier as string) ?? null,
        };
      });
      const policyById = new Map(
        (policyRows ?? []).map((p) => [
          p.id as string,
          { clientId: p.client_id as number, data: { ...(p.data ?? {}) } as Record<string, unknown> },
        ]),
      );

      await setStatus("matching", { status_detail: `Matching against ${candidates.length} policies` });

      const payload = rows.map((r, i) => {
        const m = matchRowToPolicy(r, candidates);
        return {
          agent_id: st.agent_id,
          statement_id: st.id,
          row_index: r.rowIndex,
          carrier: r.carrier ?? detectedCarrier,
          producer_code: r.producerCode,
          policy_number: r.policyNumber,
          insured_name: r.insuredName,
          product: r.product,
          transaction_type: r.transactionType,
          amount_cents: r.amountCents,
          premium_cents: r.premiumCents,
          commission_rate: r.commissionRate,
          transaction_date: r.transactionDate,
          effective_date: r.effectiveDate,
          paid_date: r.paidDate,
          period_start: r.periodStart ?? periodStart,
          period_end: r.periodEnd ?? periodEnd,
          raw: r.raw,
          dedupe_key: keys[i],
          matched_policy_id: m.policyId,
          match_method: m.method,
          match_confidence: m.confidence,
          review_status: m.policyId ? "auto" : "needs_review",
          review_reason: m.policyId ? null : (m.reason ?? "no matching policy"),
        };
      });

      // ---- replace: carry the hand work, then swap ----
      //
      // 🔴 THE ORDER IS THE SAFETY PROPERTY. The parse — the slow step, the one
      // that calls a model over the network and the only one that realistically
      // fails — has already finished by the time anything is deleted. PostgREST
      // has no transaction across calls, so the choice was "do it all in one
      // transaction" or "re-parse first and swap only on success"; this is the
      // second. The remaining window is the milliseconds between the delete and
      // the insert, and `priorRows` closes even that: the catch below puts the
      // original rows back, ids and all. A statement left with ZERO rows is
      // worse than the doubling this change exists to fix, so it must not be
      // reachable from any path.
      let carry: HandWorkCarry | null = null;
      if (replaceMode && priorRows) {
        carry = carryStatementHandWork(priorRows as unknown as ExistingRowFacts[], payload);
        carry.carried.forEach((c, i) => { if (c) Object.assign(payload[i], c); });
        await setStatus("persisting", { status_detail: `Replacing ${priorRows.length} lines with ${payload.length}` });
        const { error: delErr } = await sb
          .from("commission_rows").delete()
          .eq("statement_id", st.id).eq("agent_id", st.agent_id);
        if (delErr) throw new Error(`replace_delete_failed: ${delErr.message}`);
      }

      let inserted = 0;
      try {
        for (let i = 0; i < payload.length; i += ROW_INSERT_BATCH) {
          const batch = payload.slice(i, i + ROW_INSERT_BATCH);
          const { data, error } = await sb
            .from("commission_rows")
            .upsert(batch, { onConflict: "agent_id,dedupe_key", ignoreDuplicates: true })
            .select("id");
          if (error) throw new Error(`row_insert_failed: ${error.message}`);
          inserted += (data ?? []).length;
        }
      } catch (insErr) {
        // Put the statement back exactly as it was. Clear whatever part of the
        // new set landed first — otherwise the restore collides with it on the
        // dedupe key and silently restores nothing.
        if (replaceMode && priorRows) {
          await sb.from("commission_rows").delete()
            .eq("statement_id", st.id).eq("agent_id", st.agent_id);
          if (priorRows.length) await sb.from("commission_rows").insert(priorRows);
        }
        throw insErr;
      }

      // ---- apply what the statement is authoritative about ----
      //
      // A carrier's own statement is the best evidence the app has that a
      // policy PAID or was CHARGED BACK, so it may advance the tracker. Every
      // such change is appended to policy_status_history with source
      // 'statement' — never a silent overwrite — and `source_ref_id` names the
      // statement, which is what the drill-down opens.
      //
      // The status write and the history append are separate statements
      // rather than one transaction (PostgREST has no transaction across
      // calls). The history row is written FIRST for that reason: an
      // unexplained status change is worse than a recorded change that then
      // failed to apply, because the second one is visible and re-runnable and
      // the first is not.
      let statusChanges = 0;
      try {
        const plan = planStatementStatusChanges(
          payload,
          new Map([...policyById].map(([id, p]) => [id, (p.data.status as string) ?? null])),
        );
        for (const change of plan) {
          const pol = policyById.get(change.policyId);
          if (!pol) continue;
          const { error: histErr } = await sb.from("policy_status_history").insert({
            agent_id: st.agent_id,
            policy_client_id: pol.clientId,
            policy_id: change.policyId,
            old_status: change.from,
            new_status: change.to,
            source: "statement",
            source_detail: `${change.reason} (${st.filename})`,
            source_ref_id: st.id,
          });
          if (histErr) { console.error("history insert failed", change.policyId, histErr.message); continue; }

          pol.data.status = change.to;
          const { error: upErr } = await sb.from("policies")
            .update({ data: pol.data }).eq("id", change.policyId);
          if (upErr) { console.error("policy status update failed", change.policyId, upErr.message); continue; }
          statusChanges++;
        }
      } catch (e) {
        // A status write-back failure must never fail the ingestion: the
        // commission rows are already saved and are the primary product here.
        console.error("status write-back failed", String((e as Error).message || e));
      }

      const matched = payload.filter((p) => p.matched_policy_id).length;
      const review = payload.length - matched;
      const total = payload.reduce((n, p) => n + (p.amount_cents ?? 0), 0);

      await setStatus("ingested", {
        status_detail: null,
        error: null,
        carrier: detectedCarrier,
        period_start: periodStart,
        period_end: periodEnd,
        statement_date: periodEnd ?? periodStart,
        row_count: payload.length,
        matched_count: matched,
        review_count: review,
        total_amount_cents: total,
        parse_model: model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        parsed_at: nowIso(),
        ingested_at: nowIso(),
      });

      results.push({
        id: st.id, filename: st.filename, status: "ingested",
        rows: payload.length, inserted, matched, needs_review: review,
        // A re-run reports 0 new rows rather than pretending to have done work.
        already_present: payload.length - inserted,
        status_changes: statusChanges,
        // What the replace did, in the terms the screen reports it in. Hand
        // work that did NOT survive is counted and shown rather than quietly
        // absorbed — a line whose amount the fix corrected genuinely is a
        // different line, and the agent needs to know their approval went with
        // the old reading of it.
        replaced: replaceMode,
        lines_before: replaceMode && priorRows ? priorRows.length : null,
        lines_after: replaceMode ? payload.length : null,
        hand_work_before: carry ? carry.handWorkBefore : null,
        hand_work_carried: carry ? carry.carriedCount : null,
        hand_work_lost: carry ? carry.lostCount : null,
      });
    } catch (e) {
      await fail(String((e as Error).message || e));
    }
  }

  return json({ ok: true, processed: results.length, results });
});
