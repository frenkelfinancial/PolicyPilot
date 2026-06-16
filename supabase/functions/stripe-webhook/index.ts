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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");
  const STRIPE_SECRET  = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!STRIPE_SECRET)                     return json({ error: "stripe_not_configured" }, 500);
  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) return json({ error: "telnyx_not_configured" }, 500);

  const payload   = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || "";

  if (!await verifyStripeSignature(payload, sigHeader, STRIPE_SECRET)) {
    return json({ error: "invalid_signature" }, 400);
  }

  const event = JSON.parse(payload);
  const sb    = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Plan change / cancellation ────────────────────────────────────────────
  if (event.type === "customer.subscription.updated") {
    const sub        = event.data.object;
    const metadata   = (sub.metadata || {}) as Record<string, string>;
    const userId     = metadata.supabase_user_id;
    const planId     = metadata.plan_id;
    const customerId = sub.customer as string;
    const subId      = sub.id as string;

    if (userId) {
      // Look up the plan by stripe_price_id if plan_id is not in metadata
      let planUpdate: Record<string, unknown> = {
        stripe_customer_id:     customerId,
        stripe_subscription_id: subId,
      };
      if (planId) {
        const { data: plan } = await sb.from("plans").select("*").eq("id", planId).maybeSingle();
        if (plan) {
          planUpdate = {
            ...planUpdate,
            plan_id:              plan.id,
            monthly_minute_limit: plan.monthly_minutes,
            monthly_quote_limit:  plan.monthly_quote_limit,
          };
        }
      } else {
        // Fall back: match by stripe_price_id on the subscription item
        const priceId = sub.items?.data?.[0]?.price?.id as string | undefined;
        if (priceId) {
          const { data: plan } = await sb.from("plans").select("*").eq("stripe_price_id", priceId).maybeSingle();
          if (plan) {
            planUpdate = {
              ...planUpdate,
              plan_id:              plan.id,
              monthly_minute_limit: plan.monthly_minutes,
              monthly_quote_limit:  plan.monthly_quote_limit,
            };
          }
        }
      }
      await sb.from("agents").update(planUpdate).eq("id", userId);
    }
    return json({ ok: true });
  }

  if (event.type === "customer.subscription.deleted") {
    const sub        = event.data.object;
    const metadata   = (sub.metadata || {}) as Record<string, string>;
    const userId     = metadata.supabase_user_id;
    const customerId = sub.customer as string;

    if (userId) {
      // Find the Basic plan (smallest) to downgrade to on cancellation.
      const { data: basicPlan } = await sb.from("plans")
        .select("*").eq("slug", "basic").eq("active", true).maybeSingle();

      const downgrade: Record<string, unknown> = {
        stripe_subscription_id: null,
        stripe_customer_id:     customerId,
      };
      if (basicPlan) {
        downgrade.plan_id              = basicPlan.id;
        downgrade.monthly_minute_limit = basicPlan.monthly_minutes;
        downgrade.monthly_quote_limit  = basicPlan.monthly_quote_limit;
      }
      await sb.from("agents").update(downgrade).eq("id", userId);
    }
    return json({ ok: true });
  }

  // ── New subscription / checkout ───────────────────────────────────────────
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "customer.subscription.created"
  ) {
    return json({ ok: true, ignored: true });
  }

  const obj        = event.data.object;
  const metadata   = (obj.metadata || {}) as Record<string, string>;
  const userId     = metadata.supabase_user_id;
  const planId     = metadata.plan_id;
  const customerId = (obj.customer ?? obj.data?.object?.customer) as string | undefined;
  const subId      = (obj.subscription ?? obj.id) as string | undefined;

  if (!userId) {
    console.warn("[stripe-webhook] Event missing supabase_user_id in metadata:", event.id);
    return json({ ok: true, skipped: "no_user_id" });
  }

  if (event.type === "checkout.session.completed") {
    if (obj.payment_status && obj.payment_status !== "paid") {
      return json({ ok: true, skipped: "payment_not_complete" });
    }
  }

  // Update plan caps + store Stripe IDs
  const agentUpdate: Record<string, unknown> = {};
  if (customerId) agentUpdate.stripe_customer_id     = customerId;
  if (subId)      agentUpdate.stripe_subscription_id = subId;

  if (planId) {
    const { data: plan } = await sb.from("plans").select("*").eq("id", planId).maybeSingle();
    if (plan) {
      agentUpdate.plan_id              = plan.id;
      agentUpdate.monthly_minute_limit = plan.monthly_minutes;
      agentUpdate.monthly_quote_limit  = plan.monthly_quote_limit;
    }
  } else {
    // Fall back: match by stripe_price_id
    const priceId = obj.items?.data?.[0]?.price?.id as string | undefined;
    if (priceId) {
      const { data: plan } = await sb.from("plans").select("*").eq("stripe_price_id", priceId).maybeSingle();
      if (plan) {
        agentUpdate.plan_id              = plan.id;
        agentUpdate.monthly_minute_limit = plan.monthly_minutes;
        agentUpdate.monthly_quote_limit  = plan.monthly_quote_limit;
      }
    }
  }

  if (Object.keys(agentUpdate).length > 0) {
    await sb.from("agents").update(agentUpdate).eq("id", userId);
  }

  // Idempotent: skip phone provisioning if user already has a caller ID.
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", userId)
    .maybeSingle();

  if (agent?.signalwire_caller_id) {
    console.log(`[stripe-webhook] User ${userId} already has ${agent.signalwire_caller_id} — skipping provisioning.`);
    return json({ ok: true, skipped: "already_provisioned" });
  }

  const areaCode   = ((metadata.area_code || "202").replace(/\D/g, "").slice(0, 3)) || "202";
  const telnyxHdrs = { "Authorization": `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" };

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
