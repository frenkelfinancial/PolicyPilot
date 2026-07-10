import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assignNumberToCampaign } from "../_shared/telnyx-10dlc-adapter.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Attaches one of the agent's owned Telnyx numbers to their approved 10DLC
// campaign, so it can be used as a broadcast `from_number` (see
// messaging-broadcast-create §2's campaign-assignment check).
//
// a2p-register only submits the brand+campaign — it never assigns a
// number to it. This function closes that gap. The actual Telnyx call
// (assignNumberToCampaign, _shared/telnyx-10dlc-adapter.ts) is a
// deliberate TODO stub as of this build: the exact Telnyx endpoint/field
// names for number->campaign assignment could not be confirmed, so it
// fails closed with `not_implemented` rather than guessing. Until that
// adapter function is filled in against confirmed Telnyx docs, this
// endpoint cannot mark a number assigned — phone_numbers.a2p_campaign_id
// must be set manually via SQL after confirming the assignment out of
// band (Telnyx dashboard/support), same interim pattern already used for
// agents.outbound_email_from.
serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");

  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { phone_number_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const phoneNumberId = typeof body.phone_number_id === "string" ? body.phone_number_id : "";
  if (!phoneNumberId) return json({ error: "phone_number_id_required" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: phoneNumber } = await sb.from("phone_numbers")
    .select("id, e164, status, a2p_campaign_id")
    .eq("id", phoneNumberId)
    .eq("agent_id", user.id)
    .maybeSingle();
  if (!phoneNumber) return json({ error: "phone_number_not_found" }, 404);
  if (phoneNumber.status !== "active") {
    return json({ error: "phone_number_not_active", detail: `status is ${phoneNumber.status}` }, 400);
  }

  const { data: a2p } = await sb.from("a2p_registrations")
    .select("campaign_id, status")
    .eq("agent_id", user.id)
    .maybeSingle();
  if (!a2p || a2p.status !== "approved" || !a2p.campaign_id) {
    return json({ error: "a2p_not_approved", detail: "SMS/MMS is blocked until your A2P 10DLC brand + campaign registration is approved." }, 400);
  }

  if (phoneNumber.a2p_campaign_id === a2p.campaign_id) {
    return json({ ok: true, already_assigned: true, campaign_id: a2p.campaign_id });
  }

  const result = await assignNumberToCampaign(TELNYX_API_KEY, a2p.campaign_id, phoneNumber.e164);
  if (!result.ok) {
    return json({ error: "assignment_not_implemented", detail: result.error }, 501);
  }

  await sb.from("phone_numbers").update({ a2p_campaign_id: a2p.campaign_id }).eq("id", phoneNumber.id);

  return json({ ok: true, campaign_id: a2p.campaign_id });
});
