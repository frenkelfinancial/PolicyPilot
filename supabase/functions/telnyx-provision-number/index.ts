import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://producerstackcrm.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Service-role endpoint: auto-searches and purchases a Telnyx local number for
// a given user, then sets it as their caller ID. Called by stripe-webhook on
// subscription activation, or by admin tooling. Never called directly by users.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) {
    return json({ error: "telnyx_not_configured" }, 500);
  }

  // Require service role key — this function is not for end-user calls.
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader !== `Bearer ${SERVICE_KEY}`) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { user_id?: string; area_code?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const { user_id, area_code = "202" } = body;
  if (!user_id) return json({ error: "user_id_required" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Idempotent: skip if agent already has a caller ID.
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", user_id)
    .maybeSingle();

  if (agent?.signalwire_caller_id) {
    return json({ ok: true, skipped: true, e164: agent.signalwire_caller_id });
  }

  const cleanAC = area_code.replace(/\D/g, "").slice(0, 3);
  const telnyxHeaders = {
    "Authorization": `Bearer ${TELNYX_API_KEY}`,
    "Content-Type":  "application/json",
  };

  // Search for available local numbers in the requested area code.
  const params = new URLSearchParams({
    "filter[national_destination_code]": cleanAC,
    "filter[phone_number_type]":         "local",
    "filter[country_code]":              "US",
    "filter[limit]":                     "5",
  });

  const searchRes = await fetch(`https://api.telnyx.com/v2/available_phone_numbers?${params}`, {
    headers: { "Authorization": `Bearer ${TELNYX_API_KEY}` },
  });

  if (!searchRes.ok) {
    const err = await searchRes.text();
    return json({ error: "search_failed", detail: err }, 502);
  }

  const searchData = await searchRes.json();
  const available  = searchData.data || [];

  if (available.length === 0) {
    return json({ error: "no_numbers_available", detail: `No local numbers available in area code ${cleanAC}` }, 404);
  }

  const chosen: string = available[0].phone_number;

  // Purchase the number and assign it to the Voice API Application (same
  // connection used by the power dialer so it can dial leads from it).
  const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: telnyxHeaders,
    body: JSON.stringify({
      phone_numbers: [{ phone_number: chosen }],
      connection_id: TELNYX_CONN_ID,
    }),
  });

  if (!orderRes.ok) {
    const err = await orderRes.text();
    return json({ error: "purchase_failed", detail: err }, 502);
  }

  const orderData    = await orderRes.json();
  const orderId      = orderData?.data?.id ?? "";
  const regionInfo   = available[0].region_information || [];
  const locality     = regionInfo.find((r: { region_type: string }) => r.region_type === "locality")?.region_name ?? null;
  const region       = regionInfo.find((r: { region_type: string }) => r.region_type === "state")?.region_name ?? null;

  // Clear any old primary flag before inserting.
  await sb.from("phone_numbers").update({ is_primary: false }).eq("agent_id", user_id);

  const { error: insertErr } = await sb.from("phone_numbers").insert({
    agent_id:      user_id,
    e164:          chosen,
    friendly_name: chosen,
    locality,
    region,
    sw_phone_sid:  orderId,
    monthly_cost:  "1.00",
    is_primary:    true,
    status:        "active",
    purchased_at:  new Date().toISOString(),
  });

  if (insertErr) {
    console.error("[telnyx-provision-number] DB insert failed:", insertErr.message);
    return json({ error: "db_insert_failed", detail: insertErr.message }, 500);
  }

  const { error: updateErr } = await sb.from("agents")
    .update({ signalwire_caller_id: chosen })
    .eq("id", user_id);

  if (updateErr) {
    console.error("[telnyx-provision-number] agents update failed:", updateErr.message);
    return json({ error: "agents_update_failed", detail: updateErr.message }, 500);
  }

  console.log(`[telnyx-provision-number] Provisioned ${chosen} for user ${user_id}`);
  return json({ ok: true, e164: chosen, order_id: orderId });
});
