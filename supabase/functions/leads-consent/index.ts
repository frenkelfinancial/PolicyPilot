import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { toE164 } from "../_shared/phone.ts";

// ============================================================
// leads-consent — record (or revoke) an agent's attestation that a lead gave
// prior express consent to be called by phone.
//
// ---- Why this exists at all -----------------------------------------------
//
// `ai-call-start`'s gate 3 refuses any lead whose `leads.tcpa_consent` is not
// true, and today NOT ONE lead in production carries it. So every one of the
// twelve shipped voice campaigns is live, correct, and enrols nobody. The
// missing piece was never the campaigns — it was a way for an agent to record,
// properly, the consent they already hold on the leads they already bought.
//
// ---- Why it is an edge function and not an UPDATE ------------------------
//
// `public.leads` is fully owner-writable; it has to be, the lead book is a
// browser-side app that re-upserts every row on every save. Which means that
// until 20260803 a browser could set `tcpa_consent = true` on a lead by itself
// and the AI would then phone that person — no attestation, no named source,
// no audit row, no friction. `leads_protect_consent_columns` closed that, and
// this function is the only door left.
//
// Three things happen together or not at all, per lead:
//   1. `tcpa_consent` / `_source` / `_at` are set,
//   2. a `lead_consent_events` row records the attestation VERBATIM,
//   3. the agent comes FROM THE JWT and every write is re-scoped to them —
//      the lead ids in the body are a selection, not a boundary.
//
// ---- What it refuses ------------------------------------------------------
//
//   * The attestation unticked. It is not a formality; it is the sentence the
//     agent is putting their name to, and it is stored on every row.
//   * An empty source. "Where did this consent come from" is the question an
//     enforcement letter opens with.
//   * A lead on `dnc_list` or carrying `leads.dnc`. Somebody who said stop has
//     revoked at a level an attestation cannot reach back through. Same rule,
//     same reasoning, as messaging-consent-record.
//
// ---- What revoking does NOT do -------------------------------------------
//
// It does not touch `dnc_list` or `suppression_list`. Suppression is a
// STRONGER, separate thing: "I was wrong to think I had consent" and "this
// person told me never to call again" are different statements and collapsing
// them either over- or under-reports what the consumer actually said. Revoking
// stops the calls (gate 3 refuses immediately) and records why.
//
// Request:
//   { action: "grant", lead_ids: [uuid…], consent_source, attestation: true }
//   { action: "revoke", lead_ids: [uuid…], note? }
// Response:
//   { ok, granted|revoked, skipped: {reason: n}, results: [{lead_id, ok, reason}] }
// ============================================================

/** Leads one press of the button may touch. */
const MAX_LEADS = 2000;

/**
 * The attestation, as one string.
 *
 * It lives HERE rather than in the browser for the same reason
 * `buildOptInDisclosure()` does: what the agent ticked and what is stored have
 * to be the same sentence, and a client-supplied one is a sentence the agent
 * can edit. The modal renders this text; the server stores this text.
 */
export const CONSENT_ATTESTATION =
  "I confirm these leads gave prior express consent to be contacted by phone " +
  "by me or my agency.";

/** Sources the modal offers. Free text is allowed — this is the shortlist. */
const KNOWN_SOURCES = [
  "vendor_optin", "web_form", "inbound_call", "existing_client", "other",
];

Deno.serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

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

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const nowIso = new Date().toISOString();

  let body: {
    action?: unknown; lead_ids?: unknown; consent_source?: unknown;
    consent_source_detail?: unknown; attestation?: unknown; note?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "grant" && action !== "revoke") {
    return json({ error: "unknown_action", detail: 'action must be "grant" or "revoke".' }, 400);
  }

  const leadIds = Array.isArray(body.lead_ids)
    ? [...new Set(body.lead_ids.filter((v): v is string => typeof v === "string" && !!v))]
    : [];
  if (!leadIds.length) return json({ error: "no_leads", detail: "Select at least one lead." }, 400);
  if (leadIds.length > MAX_LEADS) {
    return json({
      error: "too_many_leads",
      detail: `Up to ${MAX_LEADS} leads at a time. Narrow the filter and do it in batches.`,
    }, 422);
  }

  // ---- Everything below is re-scoped to the caller -------------------------
  // `.eq("agent_id", user.id)` on the read is what makes the id list a
  // selection rather than a boundary: a lead belonging to somebody else simply
  // is not found, and is reported as such rather than silently ignored.
  const { data: leads, error: readErr } = await sb.from("leads")
    .select("id, client_id, data, dnc, tcpa_consent")
    .eq("agent_id", user.id)
    .in("id", leadIds);
  if (readErr) return json({ error: "read_failed", detail: readErr.message }, 500);

  const found = new Map((leads || []).map((l) => [l.id, l]));
  const skipped: Record<string, number> = {};
  const results: Array<{ lead_id: string; ok: boolean; reason?: string }> = [];
  const skip = (id: string, reason: string) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
    results.push({ lead_id: id, ok: false, reason });
  };

  for (const id of leadIds) if (!found.has(id)) skip(id, "not_found");

  // ============================================================
  // revoke
  // ============================================================
  if (action === "revoke") {
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    let revoked = 0;

    for (const lead of leads || []) {
      const d = (lead.data || {}) as Record<string, unknown>;
      const { error } = await sb.from("leads").update({
        tcpa_consent: false,
        tcpa_consent_source: null,
        tcpa_consent_at: null,
        updated_at: nowIso,
      }).eq("id", lead.id).eq("agent_id", user.id);
      if (error) { skip(lead.id, "write_failed"); continue; }

      // The columns are the CURRENT STATE and are now empty; this row is the
      // history, and it is the only place the fact of the revocation survives.
      await sb.from("lead_consent_events").insert({
        agent_id: user.id,
        lead_id: lead.id,
        client_id: lead.client_id,
        action: "revoked",
        consent_source: null,
        attestation_text: note || null,
        contact_phone: toE164(String(d.phone || "")) || null,
        lead_name: typeof d.name === "string" ? d.name : null,
      });
      revoked++;
      results.push({ lead_id: lead.id, ok: true });
    }

    return json({ ok: true, action: "revoke", revoked, skipped, results });
  }

  // ============================================================
  // grant
  // ============================================================

  // NOT A FORMALITY. This is the sentence the agent is putting their name to,
  // and it is stored verbatim on every row this request writes.
  if (body.attestation !== true) {
    return json({
      error: "attestation_required",
      detail: "Tick the confirmation before recording consent. " + CONSENT_ATTESTATION,
    }, 422);
  }

  const sourceKey = typeof body.consent_source === "string" ? body.consent_source.trim() : "";
  const sourceDetail = typeof body.consent_source_detail === "string"
    ? body.consent_source_detail.trim().slice(0, 200) : "";
  if (!sourceKey) {
    return json({
      error: "source_required",
      detail: "Say where the consent came from — it is the first thing an enforcement letter asks.",
    }, 422);
  }
  // A vendor opt-in without the vendor's name is not a record of anything.
  if (sourceKey === "vendor_optin" && !sourceDetail) {
    return json({
      error: "source_detail_required",
      detail: "Name the lead vendor whose opt-in this was.",
    }, 422);
  }
  const source = KNOWN_SOURCES.includes(sourceKey)
    ? (sourceDetail ? `${sourceKey}: ${sourceDetail}` : sourceKey)
    : sourceKey.slice(0, 200);

  // The do-not-contact list, once, for the whole batch. A person who replied
  // STOP has revoked at a level an attestation cannot reach back through:
  // re-granting for them is exactly the move enforcement exists to punish.
  const phones = (leads || [])
    .map((l) => toE164(String(((l.data || {}) as Record<string, unknown>).phone || "")))
    .filter(Boolean) as string[];
  const dncPhones = new Set<string>();
  if (phones.length) {
    const { data: dncRows } = await sb.from("dnc_list")
      .select("contact_phone, agent_id")
      .in("contact_phone", [...new Set(phones)]);
    for (const r of dncRows || []) {
      if (r.agent_id === null || r.agent_id === user.id) dncPhones.add(r.contact_phone);
    }
  }

  let granted = 0;
  for (const lead of leads || []) {
    const d = (lead.data || {}) as Record<string, unknown>;
    const phone = toE164(String(d.phone || ""));

    if (!phone) { skip(lead.id, "no_phone"); continue; }
    if (lead.dnc === true) { skip(lead.id, "dnc"); continue; }
    if (dncPhones.has(phone)) { skip(lead.id, "dnc"); continue; }

    const { error } = await sb.from("leads").update({
      tcpa_consent: true,
      tcpa_consent_source: source,
      tcpa_consent_at: nowIso,
      updated_at: nowIso,
    }).eq("id", lead.id).eq("agent_id", user.id);
    if (error) { skip(lead.id, "write_failed"); continue; }

    // One row per lead, always — including for a lead that already had
    // consent. The columns say what is true now; this table says who said so
    // and when, and re-attesting IS an event worth having on the record.
    await sb.from("lead_consent_events").insert({
      agent_id: user.id,
      lead_id: lead.id,
      client_id: lead.client_id,
      action: "granted",
      consent_source: source,
      attestation_text: CONSENT_ATTESTATION,
      contact_phone: phone,
      lead_name: typeof d.name === "string" ? d.name : null,
    });
    granted++;
    results.push({ lead_id: lead.id, ok: true });
  }

  return json({ ok: true, action: "grant", granted, source, skipped, results });
});
