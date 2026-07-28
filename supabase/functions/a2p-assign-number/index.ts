import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assignAgentNumberToCampaign } from "../_shared/a2p-assign.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Attaches one of the agent's owned Telnyx numbers to their approved 10DLC
// campaign, so it can send SMS/MMS (see messaging-broadcast-create §2's
// campaign-assignment check and the sms_capable gate on the composer).
//
// a2p-register only submits the brand+campaign — it never assigns a number.
// This function closes that gap. All the work (preconditions, the Telnyx
// call, and the DB writes for ASSIGNED/PENDING/FAILED) lives in the shared
// _shared/a2p-assign.ts routine, which telnyx-buy-number also uses to
// auto-assign a number bought after approval.
//
// Outcomes:
//   ASSIGNED            -> phone_numbers.a2p_campaign_id + sms_capable set; ok.
//   PENDING_ASSIGNMENT  -> pending state stored, a2p_campaign_id left null;
//                          a2p-status-poll confirms it. Carrier propagation
//                          then takes 24-72h before delivery is reliable.
//   FAILED_ASSIGNMENT   -> failure reason stored + returned 502 to the UI.
//   already assigned    -> ok with no second Telnyx call (idempotent).
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
  const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");

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

  const outcome = await assignAgentNumberToCampaign(
    sb, TELNYX_API_KEY, TELNYX_MSG_PROFILE_ID, user.id, phoneNumberId,
  );

  if (!outcome.ok) {
    // precondition failures carry their own httpStatus (400/404/409);
    // Telnyx FAILED_ASSIGNMENT comes back as 502 with the reason surfaced.
    return json({ error: outcome.reason.split(":")[0], detail: outcome.reason }, outcome.httpStatus);
  }

  if (outcome.status === "pending") {
    return json({
      ok: true,
      status: "pending_assignment",
      campaign_id: outcome.campaignId,
      detail: "Number submitted for assignment. It becomes textable once the carrier confirms it (checked automatically); delivery is fully reliable ~24-72h after that.",
    });
  }

  return json({
    ok: true,
    status: "assigned",
    already_assigned: outcome.alreadyAssigned,
    campaign_id: outcome.campaignId,
  });
});
