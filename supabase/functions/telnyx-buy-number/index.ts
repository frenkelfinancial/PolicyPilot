import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { e164?: string; friendly_name?: string | null; locality?: string | null; region?: string | null };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const e164 = body.e164;
  if (!e164 || !/^\+1\d{10}$/.test(e164)) {
    return json({ error: "invalid_number", detail: "Must be a US E.164 number like +14155551234" }, 400);
  }

  // Purchase the number from Telnyx and assign it to the connection
  const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      phone_numbers: [{ phone_number: e164 }],
      connection_id: TELNYX_CONN_ID,
    }),
  });

  if (!orderRes.ok) {
    const err = await orderRes.text();
    return json({ ok: false, error: `Telnyx purchase failed: ${err}` }, 502);
  }

  const orderData = await orderRes.json();
  // Grab the Telnyx order ID as our phone SID (stored in sw_phone_sid column)
  const telnyxPhoneSid: string = orderData?.data?.id || orderData?.data?.phone_numbers?.[0]?.id || "";

  // Store in phone_numbers table
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { error: insertErr } = await sb.from("phone_numbers").insert({
    agent_id:      user.id,
    e164,
    friendly_name: body.friendly_name || e164,
    locality:      body.locality  ?? null,
    region:        body.region    ?? null,
    sw_phone_sid:  telnyxPhoneSid,
    monthly_cost:  "1.00",
    is_primary:    false,
    status:        "active",
    purchased_at:  new Date().toISOString(),
  });

  if (insertErr) {
    console.warn("[telnyx-buy-number] DB insert failed:", insertErr.message);
    return json({ ok: false, error: "Purchase succeeded at Telnyx but failed to save to database: " + insertErr.message }, 500);
  }

  return json({ ok: true, e164 });
});
