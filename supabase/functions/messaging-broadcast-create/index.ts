import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toE164 } from "../_shared/phone.ts";
import { expandLeadsToRecipients, leadMatchesStatusFilter, type LeadRow } from "../_shared/leads.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Creates a mass-text broadcast and (optionally) expands its CRM-lead
// recipients. CSV-sourced recipients are added afterward via
// messaging-recipients-import against the returned broadcast_id — both
// sources land in the same public.broadcast_recipients table.
//
// The easy-to-miss gate (PROMPT_07 §2): the chosen from_number must (a)
// belong to this agent and be active, and (b) already be assigned to the
// agent's APPROVED Telnyx 10DLC campaign (phone_numbers.a2p_campaign_id —
// set by a2p-assign-number). Neither check is optional; A2P approval
// alone is not enough, since Telnyx requires the number itself to be
// attached to the campaign before it will carry traffic for it. Failing
// either returns a clear 400 and creates nothing — no draft broadcast,
// no recipients, no charges.
//
// Small broadcasts (<= SMALL_LIST_INLINE_THRESHOLD pending recipients)
// are handed straight to messaging-broadcast-run so they start sending
// immediately; larger ones are left `queued` for the cron sweep (see
// messaging-broadcast-run) to drain in batches.
const SMALL_LIST_INLINE_THRESHOLD = 25;

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const CRON_SECRET   = Deno.env.get("WALLET_CRON_SECRET");

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: {
    from_number?: unknown;
    channel?: unknown;
    body?: unknown;
    media_url?: unknown;
    lead_filter?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const channel = body.channel === "mms" ? "mms" : body.channel === "sms" ? "sms" : null;
  if (!channel) return json({ error: "channel_must_be_sms_or_mms" }, 400);

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return json({ error: "body_required" }, 400);

  const mediaUrl = typeof body.media_url === "string" ? body.media_url.trim() : "";
  if (channel === "mms" && !mediaUrl) return json({ error: "media_url_required_for_mms" }, 400);

  const fromRaw = typeof body.from_number === "string" ? body.from_number.trim() : "";
  const fromNumber = toE164(fromRaw);
  if (!fromNumber) return json({ error: "invalid_from_number", detail: `"${fromRaw}" does not normalize to a valid E.164 phone number.` }, 400);

  const leadFilter = typeof body.lead_filter === "string" ? body.lead_filter.trim() : "";

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- §2: from-number ownership + A2P campaign assignment. ---
  const { data: phoneNumber } = await sb.from("phone_numbers")
    .select("id, e164, status, a2p_campaign_id")
    .eq("agent_id", user.id)
    .eq("e164", fromNumber)
    .maybeSingle();
  if (!phoneNumber) return json({ error: "from_number_not_found", detail: "This number is not in your phone inventory." }, 404);
  if (phoneNumber.status !== "active") {
    return json({ error: "from_number_not_active", detail: `Number status is "${phoneNumber.status}".` }, 400);
  }

  const { data: a2p } = await sb.from("a2p_registrations")
    .select("campaign_id, status")
    .eq("agent_id", user.id)
    .maybeSingle();
  if (!a2p || a2p.status !== "approved" || !a2p.campaign_id) {
    return json({ error: "a2p_not_approved", detail: "SMS/MMS broadcasts are blocked until your A2P 10DLC brand + campaign registration is approved." }, 400);
  }
  if (phoneNumber.a2p_campaign_id !== a2p.campaign_id) {
    return json({
      error: "number_not_campaign_assigned",
      detail: "This number is not yet assigned to your approved 10DLC campaign — call a2p-assign-number for it first.",
    }, 400);
  }

  // --- Create the broadcast row. ---
  const { data: broadcastRow, error: insertErr } = await sb.from("broadcasts").insert({
    agent_id:    user.id,
    from_number: fromNumber,
    channel,
    body:        text,
    media_url:   mediaUrl || null,
    status:      "draft",
  }).select("id").single();

  if (insertErr || !broadcastRow) {
    return json({ error: "db_insert_failed", detail: insertErr?.message }, 500);
  }
  const broadcastId = broadcastRow.id as string;

  // --- CRM lead expansion (optional at create time — CSV recipients are
  //     added afterward via messaging-recipients-import against this
  //     broadcast_id). ---
  let totalRecipients = 0;
  let skippedCount = 0;
  let pendingCount = 0;

  if (leadFilter) {
    const { data: leadRows } = await sb.from("leads")
      .select("id, data")
      .eq("agent_id", user.id);

    const matching = ((leadRows || []) as LeadRow[]).filter((l) => leadMatchesStatusFilter(l, leadFilter));
    const { recipients, invalid } = expandLeadsToRecipients(matching);

    const rows = [
      ...recipients.map((r) => ({
        broadcast_id: broadcastId,
        agent_id:     user.id,
        to_address:   r.toAddress,
        lead_id:      r.leadId,
        source:       "lead",
        status:       "pending",
      })),
      ...invalid.map((r) => ({
        broadcast_id: broadcastId,
        agent_id:     user.id,
        to_address:   r.rawPhone || `invalid:${r.leadId}`,
        lead_id:      r.leadId,
        source:       "lead",
        status:       "skipped",
        skip_reason:  "invalid_phone",
      })),
    ];

    if (rows.length > 0) {
      const { error: recipErr } = await sb.from("broadcast_recipients").insert(rows);
      if (recipErr) {
        return json({ error: "recipient_insert_failed", detail: recipErr.message, broadcast_id: broadcastId }, 500);
      }
    }

    // total_recipients counts every recipient row (pending + skipped) —
    // same definition messaging-recipients-import uses when it recomputes
    // these totals after a CSV import, so the two functions never disagree
    // about what "total" means for the same broadcast.
    totalRecipients = rows.length;
    skippedCount = invalid.length;
    pendingCount = recipients.length;
  }

  const newStatus = pendingCount > 0 ? "queued" : "draft";
  await sb.from("broadcasts").update({
    total_recipients: totalRecipients,
    skipped_count:    skippedCount,
    status:           newStatus,
  }).eq("id", broadcastId);

  // --- Small lists: kick the runner immediately (best-effort — a failed
  //     inline kick just leaves the broadcast queued for the cron sweep,
  //     it never fails this request). ---
  if (newStatus === "queued" && totalRecipients <= SMALL_LIST_INLINE_THRESHOLD && CRON_SECRET) {
    fetch(`${SUPABASE_URL}/functions/v1/messaging-broadcast-run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CRON_SECRET}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ broadcast_id: broadcastId }),
    }).catch((err) => console.error("[messaging-broadcast-create] inline run kick failed (broadcast stays queued for the cron sweep):", err));
  }

  return json({
    ok: true,
    broadcast_id: broadcastId,
    status: newStatus,
    total_recipients: totalRecipients,
    skipped_count: skippedCount,
  });
});
