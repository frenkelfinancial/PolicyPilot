import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseCsv } from "../_shared/csv.ts";
import { toE164 } from "../_shared/phone.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Imports an uploaded CSV of recipients into an existing (draft/queued)
// broadcast: normalizes phones, writes public.consent_records for each
// one with the agent-supplied provenance, and inserts broadcast_recipients
// rows (source='csv'). Numbers already present on the broadcast (from a
// prior lead expansion or an earlier import) are skipped as duplicates —
// the DB's unique(broadcast_id, to_address) constraint is the backstop.
//
// LEGAL GUARDRAIL (PROMPT_07 §3): this function NEVER invents consent. A
// row (or the whole-file default) must supply an explicit consent_type —
// 'express_written' is only written when the agent explicitly says so,
// never assumed. A phone number that ends up with no qualifying
// consent_records row is not blocked here; it is correctly left to fail
// at send time in runComplianceGate (messaging-shared.ts) — that is the
// actual enforcement point, this function only records what the agent
// told us.
const VALID_CONSENT_TYPES = new Set(["express_written", "express", "none"]);

function fieldCI(row: Record<string, string>, name: string): string {
  const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? row[key].trim() : "";
}

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: {
    broadcast_id?: unknown;
    csv_text?: unknown;
    consent?: { consent_type?: unknown; source?: unknown; captured_at?: unknown };
  };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const broadcastId = typeof body.broadcast_id === "string" ? body.broadcast_id : "";
  const csvText = typeof body.csv_text === "string" ? body.csv_text : "";
  if (!broadcastId || !csvText) return json({ error: "broadcast_id_and_csv_text_required" }, 400);

  const defaultConsentType = typeof body.consent?.consent_type === "string" ? body.consent.consent_type : "";
  const defaultSource = typeof body.consent?.source === "string" ? body.consent.source.trim() : "";
  const defaultCapturedAt = typeof body.consent?.captured_at === "string" ? body.consent.captured_at : "";

  if (!defaultConsentType || !VALID_CONSENT_TYPES.has(defaultConsentType) || !defaultSource) {
    return json({
      error: "consent_basis_required",
      detail: "Provide consent.consent_type (express_written/express/none) and consent.source — this is the legal basis recorded for every row that doesn't override it. Never guessed.",
    }, 400);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: broadcast } = await sb.from("broadcasts")
    .select("id, status")
    .eq("id", broadcastId)
    .eq("agent_id", user.id)
    .maybeSingle();
  if (!broadcast) return json({ error: "broadcast_not_found" }, 404);
  if (!["draft", "queued"].includes(broadcast.status)) {
    return json({ error: "broadcast_not_editable", detail: `status is "${broadcast.status}".` }, 400);
  }

  const { headers, rows } = parseCsv(csvText);
  if (!headers.some((h) => h.toLowerCase() === "phone")) {
    return json({ error: "phone_column_required", detail: `CSV headers found: ${headers.join(", ") || "(none)"}` }, 400);
  }

  const { data: existingRows } = await sb.from("broadcast_recipients")
    .select("to_address")
    .eq("broadcast_id", broadcastId);
  const existing = new Set((existingRows || []).map((r: { to_address: string }) => r.to_address));

  const capturedAtDefault = defaultCapturedAt || new Date().toISOString();
  const recipientRows: Record<string, unknown>[] = [];
  const consentRows: Record<string, unknown>[] = [];
  const seenThisImport = new Set<string>();
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const row of rows) {
    const rawPhone = fieldCI(row, "phone");
    const e164 = toE164(rawPhone);

    if (!e164) {
      invalidCount++;
      recipientRows.push({
        broadcast_id: broadcastId,
        agent_id:     user.id,
        to_address:   rawPhone || `invalid:${crypto.randomUUID()}`,
        source:       "csv",
        status:       "skipped",
        skip_reason:  "invalid_phone",
      });
      continue;
    }

    if (existing.has(e164) || seenThisImport.has(e164)) {
      duplicateCount++;
      continue; // duplicate — the row already on this broadcast (or an earlier row in this same file) wins.
    }
    seenThisImport.add(e164);

    const rowConsentType = fieldCI(row, "consent_type");
    const consentType = rowConsentType && VALID_CONSENT_TYPES.has(rowConsentType) ? rowConsentType : defaultConsentType;
    const consentSourceNote = fieldCI(row, "consent_source");
    const consentSource = consentSourceNote ? `csv_import: ${consentSourceNote}` : `csv_import: ${defaultSource}`;
    const consentCapturedAt = fieldCI(row, "consent_captured_at") || capturedAtDefault;

    consentRows.push({
      agent_id:      user.id,
      contact_phone: e164,
      consent_type:  consentType,
      source:        consentSource,
      captured_at:   consentCapturedAt,
    });

    recipientRows.push({
      broadcast_id: broadcastId,
      agent_id:     user.id,
      to_address:   e164,
      source:       "csv",
      status:       "pending",
    });
  }

  if (consentRows.length > 0) {
    const { error: consentErr } = await sb.from("consent_records").insert(consentRows);
    if (consentErr) return json({ error: "consent_write_failed", detail: consentErr.message }, 500);
  }

  if (recipientRows.length > 0) {
    const { error: recipErr } = await sb.from("broadcast_recipients").insert(recipientRows);
    if (recipErr) return json({ error: "recipient_insert_failed", detail: recipErr.message }, 500);
  }

  const importedCount = recipientRows.length - invalidCount;

  const { count: totalCount } = await sb.from("broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId);
  const { count: skippedTotal } = await sb.from("broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId)
    .eq("status", "skipped");

  await sb.from("broadcasts").update({
    total_recipients: totalCount ?? 0,
    skipped_count:    skippedTotal ?? 0,
    status:           broadcast.status === "draft" ? "queued" : broadcast.status,
  }).eq("id", broadcastId);

  return json({
    ok: true,
    broadcast_id: broadcastId,
    imported: importedCount,
    consent_records_written: consentRows.length,
    skipped_invalid: invalidCount,
    skipped_duplicate: duplicateCount,
  });
});
