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
  const STRIPE_SECRET  = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!STRIPE_SECRET) return json({ error: "stripe_not_configured" }, 500);

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
    const subStatus  = sub.status as string;

    if (userId) {
      // Subscription canceled or unpaid — revoke access immediately.
      if (subStatus === "canceled" || subStatus === "unpaid") {
        await sb.from("agents").update({
          plan_id:                null,
          monthly_minute_limit:   0,
          monthly_quote_limit:    0,
          stripe_subscription_id: null,
          stripe_customer_id:     customerId,
        }).eq("id", userId);
        return json({ ok: true });
      }

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
      // Subscription deleted — revoke dashboard access by clearing plan_id.
      await sb.from("agents").update({
        plan_id:                null,
        monthly_minute_limit:   0,
        monthly_quote_limit:    0,
        stripe_subscription_id: null,
        stripe_customer_id:     customerId,
      }).eq("id", userId);
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

  return json({ ok: true });
});
