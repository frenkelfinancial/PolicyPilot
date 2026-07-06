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

// After a number is purchased, add it to the agent's Stripe subscription.
// If the agent has no subscription yet, or billing config lacks a numbers price,
// this is a silent no-op (billing will catch up when they subscribe).
async function syncNumberOnStripe(
  sb: ReturnType<typeof createClient>,
  stripeKey: string,
  agentId: string,
) {
  try {
    const [agentRes, configRes] = await Promise.all([
      sb.from("agents")
        .select("stripe_subscription_id, stripe_numbers_item_id")
        .eq("id", agentId)
        .maybeSingle(),
      sb.from("billing_config")
        .select("stripe_numbers_price_id")
        .eq("id", 1)
        .maybeSingle(),
    ]);

    const agent  = agentRes.data;
    const config = configRes.data;

    if (!agent?.stripe_subscription_id) return;
    if (!config?.stripe_numbers_price_id) return;

    const stripeHdrs = {
      "Authorization": `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const existingItemId = agent.stripe_numbers_item_id;

    if (!existingItemId) {
      // Check if the numbers item was already created via a numbers checkout session.
      const listRes = await fetch(
        `https://api.stripe.com/v1/subscription_items?subscription=${agent.stripe_subscription_id}&limit=20`,
        { headers: stripeHdrs },
      );
      if (listRes.ok) {
        const listData = await listRes.json();
        const found = (listData.data || []).find(
          (item: { price?: { id: string }; id: string }) =>
            item.price?.id === config.stripe_numbers_price_id,
        );
        if (found) {
          // Item already exists from checkout — record it; quantity already matches.
          await sb.from("agents")
            .update({ stripe_numbers_item_id: found.id })
            .eq("id", agentId);
          console.log(`[telnyx-buy-number] Recorded existing Stripe number item ${found.id} for agent ${agentId}`);
          return;
        }
      }

      // First number purchase — add a new subscription item with quantity 1.
      const addParams = new URLSearchParams({
        "subscription":             agent.stripe_subscription_id,
        "price":                    config.stripe_numbers_price_id,
        "quantity":                 "1",
        "proration_behavior":       "create_prorations",
      });
      const addRes = await fetch("https://api.stripe.com/v1/subscription_items", {
        method: "POST",
        headers: stripeHdrs,
        body: addParams,
      });
      if (!addRes.ok) {
        console.warn("[telnyx-buy-number] Stripe add number item failed:", await addRes.text());
        return;
      }
      const newItem = await addRes.json();
      await sb.from("agents")
        .update({ stripe_numbers_item_id: newItem.id })
        .eq("id", agentId);
      console.log(`[telnyx-buy-number] Created Stripe number item ${newItem.id} for agent ${agentId}`);
      return;
    }

    // Subsequent purchase — fetch current quantity and increment by 1.
    const itemRes = await fetch(
      `https://api.stripe.com/v1/subscription_items/${existingItemId}`,
      { headers: stripeHdrs },
    );
    if (!itemRes.ok) {
      console.warn("[telnyx-buy-number] Stripe fetch item failed:", await itemRes.text());
      return;
    }
    const item = await itemRes.json();
    const newQty = (item.quantity || 0) + 1;

    const updateParams = new URLSearchParams({
      "quantity":           String(newQty),
      "proration_behavior": "create_prorations",
    });
    const updateRes = await fetch(
      `https://api.stripe.com/v1/subscription_items/${existingItemId}`,
      { method: "POST", headers: stripeHdrs, body: updateParams },
    );
    if (!updateRes.ok) {
      console.warn("[telnyx-buy-number] Stripe update qty failed:", await updateRes.text());
      return;
    }
    console.log(`[telnyx-buy-number] Updated Stripe number qty to ${newQty} for agent ${agentId}`);
  } catch (e) {
    console.error("[telnyx-buy-number] Stripe sync error:", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");
  const STRIPE_KEY     = Deno.env.get("STRIPE_SECRET_KEY");

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  // Require an active paid plan (or admin) before allowing a purchase.
  // Numbers are billed to us immediately by Telnyx regardless of whether the
  // agent ever completes Stripe checkout, so this must be checked here — not
  // just gated client-side — or an authenticated-but-unpaid session can buy
  // numbers for free.
  const DEV_EMAIL_GATE = 'jacef8778099@gmail.com';
  if (user.email !== DEV_EMAIL_GATE) {
    const sbCheck = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: agentCheck } = await sbCheck.from("agents")
      .select("plan_id, is_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!agentCheck?.is_admin && !agentCheck?.plan_id) {
      return json({ error: "active_subscription_required" }, 402);
    }
  }

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
  // phone_numbers[0].id is the phone number resource ID; data.id is the order ID
  const telnyxPhoneSid: string = orderData?.data?.phone_numbers?.[0]?.id || orderData?.data?.id || "";

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Get current billing config to store the correct rate on the phone_numbers row
  const { data: billingConfig } = await sb.from("billing_config")
    .select("number_rate_cents")
    .eq("id", 1)
    .maybeSingle();
  const monthlyCostDollars = ((billingConfig?.number_rate_cents ?? 300) / 100).toFixed(2);

  // If this is the agent's first number, auto-set it as primary so they can
  // call immediately without a manual "Set as Primary" step.
  // Also read the agent's global CNAM setting to auto-apply to the new number.
  const { data: agentRow } = await sb.from("agents")
    .select("signalwire_caller_id, cnam_name")
    .eq("id", user.id)
    .maybeSingle();
  const isFirstNumber = !agentRow?.signalwire_caller_id;
  const cnamName: string | null = agentRow?.cnam_name || null;

  const { error: insertErr } = await sb.from("phone_numbers").insert({
    agent_id:      user.id,
    e164,
    friendly_name: body.friendly_name || e164,
    locality:      body.locality  ?? null,
    region:        body.region    ?? null,
    sw_phone_sid:  telnyxPhoneSid,
    monthly_cost:  monthlyCostDollars,
    is_primary:    isFirstNumber,
    status:        "active",
    purchased_at:  new Date().toISOString(),
  });

  // Best-effort: apply the agent's global CNAM to the new number on Telnyx.
  if (cnamName && telnyxPhoneSid) {
    try {
      const patchRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxPhoneSid}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${TELNYX_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({ caller_id: { name: cnamName } }),
      });
      if (!patchRes.ok) {
        console.warn("[telnyx-buy-number] CNAM PATCH failed:", await patchRes.text());
      } else {
        console.log(`[telnyx-buy-number] Auto-applied CNAM "${cnamName}" to ${e164}`);
      }
    } catch (e) {
      console.warn("[telnyx-buy-number] CNAM set error:", e);
    }
  }

  if (insertErr) {
    console.warn("[telnyx-buy-number] DB insert failed:", insertErr.message);
    return json({ ok: false, error: "Purchase succeeded at Telnyx but failed to save to database: " + insertErr.message }, 500);
  }

  if (isFirstNumber) {
    await sb.from("agents")
      .update({ signalwire_caller_id: e164 })
      .eq("id", user.id);
    console.log(`[telnyx-buy-number] Auto-set ${e164} as primary caller ID for agent ${user.id}`);
  }

  // Sync the phone number quantity to the agent's Stripe subscription.
  // Best-effort — never fails the buy response.
  // Developer account skips Stripe billing entirely.
  const DEV_EMAIL = 'jacef8778099@gmail.com';
  if (STRIPE_KEY && user.email !== DEV_EMAIL) {
    await syncNumberOnStripe(sb, STRIPE_KEY, user.id);
  }

  return json({ ok: true, e164, set_as_primary: isFirstNumber });
});
