import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Verify Stripe webhook signature using Web Crypto (no Stripe SDK needed).
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(",")) {
    const [k, v] = part.split("=");
    if (k && v) parts[k] = v;
  }
  const ts = parts["t"];
  const v1 = parts["v1"];
  if (!ts || !v1) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig      = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${payload}`));
  const computed = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return computed === v1;
}

// Listens for Stripe checkout.session.completed (one-time or subscription) and
// customer.subscription.created events. On success, auto-purchases a Telnyx
// local phone number for the subscribing user and sets it as their caller ID.
//
// REQUIRED Stripe metadata on Checkout Session or Subscription:
//   metadata.supabase_user_id  — the user's Supabase auth UID
//   metadata.area_code         — (optional) 3-digit area code, defaults to "202"
//
// REQUIRED Supabase secrets:
//   STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks → Signing secret
//   TELNYX_API_KEY
//   TELNYX_CONNECTION_ID
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");
  const STRIPE_SECRET  = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!STRIPE_SECRET)                     return json({ error: "stripe_not_configured" }, 500);
  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) return json({ error: "telnyx_not_configured" }, 500);

  // Stripe sends the raw body — must be read before any parsing.
  const payload   = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || "";

  if (!await verifyStripeSignature(payload, sigHeader, STRIPE_SECRET)) {
    return json({ error: "invalid_signature" }, 400);
  }

  const event = JSON.parse(payload);

  // Only handle relevant events.
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "customer.subscription.created"
  ) {
    return json({ ok: true, ignored: true });
  }

  // Extract supabase_user_id from metadata. When creating a Checkout Session,
  // pass: metadata: { supabase_user_id: user.id, area_code: "415" }
  const metadata: Record<string, string> = event.data?.object?.metadata || {};
  const userId = metadata.supabase_user_id;

  if (!userId) {
    console.warn("[stripe-webhook] Event missing supabase_user_id in metadata:", event.id);
    return json({ ok: true, skipped: "no_user_id" });
  }

  // For checkout.session.completed with payment_status !== 'paid', skip.
  if (event.type === "checkout.session.completed") {
    const paymentStatus = event.data?.object?.payment_status;
    if (paymentStatus && paymentStatus !== "paid") {
      return json({ ok: true, skipped: "payment_not_complete" });
    }
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Idempotent: skip if user already has a caller ID.
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", userId)
    .maybeSingle();

  if (agent?.signalwire_caller_id) {
    console.log(`[stripe-webhook] User ${userId} already has ${agent.signalwire_caller_id} — skipping.`);
    return json({ ok: true, skipped: "already_provisioned" });
  }

  const areaCode    = (metadata.area_code || "202").replace(/\D/g, "").slice(0, 3);
  const telnyxHdrs  = { "Authorization": `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" };

  // Search for an available local number in the requested area code.
  const searchParams = new URLSearchParams({
    "filter[national_destination_code]": areaCode,
    "filter[phone_number_type]":         "local",
    "filter[country_code]":              "US",
    "filter[limit]":                     "5",
  });

  const searchRes = await fetch(`https://api.telnyx.com/v2/available_phone_numbers?${searchParams}`, {
    headers: { "Authorization": `Bearer ${TELNYX_API_KEY}` },
  });

  if (!searchRes.ok) {
    const err = await searchRes.text();
    console.error("[stripe-webhook] Telnyx search failed:", err);
    return json({ error: "search_failed", detail: err }, 502);
  }

  const searchData = await searchRes.json();
  const available  = searchData.data || [];

  if (available.length === 0) {
    console.error(`[stripe-webhook] No numbers in area code ${areaCode} for user ${userId}`);
    return json({ error: "no_numbers_available", area_code: areaCode }, 404);
  }

  const chosen: string = available[0].phone_number;

  // Purchase and assign to the Voice API Application.
  const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: telnyxHdrs,
    body: JSON.stringify({
      phone_numbers: [{ phone_number: chosen }],
      connection_id: TELNYX_CONN_ID,
    }),
  });

  if (!orderRes.ok) {
    const err = await orderRes.text();
    console.error("[stripe-webhook] Telnyx purchase failed:", err);
    return json({ error: "purchase_failed", detail: err }, 502);
  }

  const orderData  = await orderRes.json();
  const orderId    = orderData?.data?.id ?? "";
  const regionInfo = available[0].region_information || [];
  const locality   = regionInfo.find((r: { region_type: string }) => r.region_type === "locality")?.region_name ?? null;
  const region     = regionInfo.find((r: { region_type: string }) => r.region_type === "state")?.region_name ?? null;

  // Clear old primary flag (shouldn't exist, but be safe).
  await sb.from("phone_numbers").update({ is_primary: false }).eq("agent_id", userId);

  const { error: insertErr } = await sb.from("phone_numbers").insert({
    agent_id:      userId,
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
    console.error("[stripe-webhook] DB insert failed:", insertErr.message);
    return json({ error: "db_insert_failed", detail: insertErr.message }, 500);
  }

  const { error: updateErr } = await sb.from("agents")
    .update({ signalwire_caller_id: chosen })
    .eq("id", userId);

  if (updateErr) {
    console.error("[stripe-webhook] agents update failed:", updateErr.message);
    return json({ error: "agents_update_failed", detail: updateErr.message }, 500);
  }

  console.log(`[stripe-webhook] Provisioned ${chosen} for user ${userId} (order ${orderId})`);
  return json({ ok: true, e164: chosen, order_id: orderId });
});
