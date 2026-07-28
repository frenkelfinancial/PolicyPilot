import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { toE164 } from "../_shared/phone.ts";

// ============================================================
// messaging-consent-record — record ONE contact's TCPA consent.
//
// WHY THIS EXISTS
// ---------------
// The compliance gate in _shared/messaging-shared.ts refuses any SMS/MMS
// send without a current, unrevoked consent_records row for the recipient.
// Until now the ONLY thing that ever wrote that table was
// messaging-recipients-import — the broadcast CSV path. `lead-ingest` does
// not write it, and `consent_records` has SELECT-only RLS (019 §8), so the
// browser cannot write it either.
//
// Net effect before this function: an agent could be fully A2P-approved with
// an assigned texting number and still have every 1:1 text to a lead
// rejected with `no_consent`. The consent genuinely existed — it is captured
// on the vendor's lead form and certified by TrustedForm — it was simply
// never recorded anywhere our gate could see.
//
// WHAT THIS IS NOT
// ----------------
// It is not a way to manufacture consent. It records an EXPLICIT agent
// attestation about where consent came from, with the provenance string
// stored verbatim in consent_records.source for audit. The same guardrail
// messaging-recipients-import documents applies here: `consent_type` is
// never defaulted to express_written — the caller must state it, and the UI
// only offers it behind a written attestation the agent has to tick.
//
// Refuses outright when the contact is on the do-not-contact list. A person
// who texted STOP has revoked consent at the carrier level; re-adding a
// consent row for them would step around the one signal TCPA treats as
// absolute. That needs a fresh, deliberate opt-in through an inbound START,
// which messaging-inbound-webhook already handles.
//
// Request:  { contact_phone, consent_type: "express_written"|"express",
//             source, captured_at? }
// Response: { ok, consent_id, contact_phone, consent_type, already_on_file }
// ============================================================

const VALID_CONSENT_TYPES = new Set(["express_written", "express"]);

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
    contact_phone?: unknown;
    consent_type?: unknown;
    source?: unknown;
    captured_at?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  // Canonical E.164 or nothing. A number stored in any other format silently
  // fails to match at send time, which is worse than refusing it here — see
  // the PHONE FORMAT note at the top of 019_messaging_compliance.sql.
  const raw = typeof body.contact_phone === "string" ? body.contact_phone : "";
  const contactPhone = toE164(raw);
  if (!contactPhone) {
    return json({
      error: "invalid_phone",
      detail: `"${raw}" is not a valid US phone number, so there is nothing to attach consent to.`,
    }, 400);
  }

  // Never defaulted. The caller states the basis or the request fails.
  const consentType = typeof body.consent_type === "string" ? body.consent_type : "";
  if (!VALID_CONSENT_TYPES.has(consentType)) {
    return json({
      error: "consent_type_required",
      detail: "consent_type must be \"express_written\" (a written opt-in, e.g. a lead form with a TrustedForm certificate) " +
        "or \"express\" (oral/implied). It is never assumed.",
    }, 400);
  }

  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) {
    return json({
      error: "source_required",
      detail: "source must say where the consent came from — it is the audit trail a regulator reads.",
    }, 400);
  }

  const capturedAt = typeof body.captured_at === "string" && body.captured_at
    ? body.captured_at
    : new Date().toISOString();

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // A contact on the DNC list has said stop. Recording consent over the top
  // of that is exactly the move TCPA enforcement exists to punish.
  const { data: dncRows } = await sb.from("dnc_list")
    .select("agent_id, reason, source")
    .eq("contact_phone", contactPhone);
  const dnc = (dncRows || []).find((r: { agent_id: string | null }) => r.agent_id === null || r.agent_id === user.id);
  if (dnc) {
    return json({
      error: "on_dnc_list",
      detail: dnc.source === "opt_out_keyword"
        ? "This person replied STOP, so they are opted out. We cannot record new consent for them — they have to text START back to resubscribe."
        : "This number is on your do-not-contact list, so consent cannot be recorded for it.",
    }, 409);
  }

  // Already covered? The gate reads the most recent unrevoked row, so a
  // second identical row would change nothing and just add noise to the
  // audit trail. Report it rather than writing it.
  const { data: existing } = await sb.from("consent_records")
    .select("id, consent_type, revoked_at")
    .eq("agent_id", user.id)
    .eq("contact_phone", contactPhone)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing && !existing.revoked_at && existing.consent_type === consentType) {
    return json({
      ok: true,
      already_on_file: true,
      consent_id: existing.id,
      contact_phone: contactPhone,
      consent_type: existing.consent_type,
    });
  }

  // consent_records is append-only by design — a re-grant after a revoke is a
  // NEW row, never an update of the old one.
  const { data: inserted, error: insertErr } = await sb.from("consent_records")
    .insert({
      agent_id:      user.id,
      contact_phone: contactPhone,
      consent_type:  consentType,
      source,
      captured_at:   capturedAt,
    })
    .select("id")
    .maybeSingle();

  if (insertErr) {
    return json({ error: "consent_write_failed", detail: insertErr.message }, 500);
  }

  return json({
    ok: true,
    already_on_file: false,
    consent_id: inserted?.id ?? null,
    contact_phone: contactPhone,
    consent_type: consentType,
  });
});
