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

async function telnyxReleaseByE164(apiKey: string, e164: string): Promise<void> {
  const params = new URLSearchParams({ "filter[phone_number]": e164 });
  const listRes = await fetch(`https://api.telnyx.com/v2/phone_numbers?${params}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!listRes.ok) throw new Error(`Telnyx list failed: ${await listRes.text()}`);
  const listData = await listRes.json();
  const records = listData.data || [];
  if (!records.length) return; // already released — skip silently
  const telnyxId = records[0].id;
  const delRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!delRes.ok && delRes.status !== 404) {
    throw new Error(`Telnyx release failed: ${await delRes.text()}`);
  }
}

// Called by the authenticated browser when an agent cancels their subscription.
//
// Effects (all immediate):
//   1. Stripe subscription set to cancel_at_period_end = true (access until period end)
//   2. All phone numbers released from Telnyx immediately
//   3. All phone_numbers rows deleted from DB
//   4. signalwire_caller_id and stripe_numbers_item_id cleared on agents row
//
// Response:
//   { ok: true, access_until: "<ISO date>", numbers_released: N }
//
// Dev account (jacef8778099@gmail.com) skips Stripe and Telnyx — only clears DB rows.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
  const STRIPE_KEY        = Deno.env.get("STRIPE_SECRET_KEY");
  const TELNYX_API_KEY    = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_DIALER_NUM = Deno.env.get("TELNYX_DIALER_NUMBER");
  const DEV_EMAIL         = "jacef8778099@gmail.com";

  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const isDev = user.email === DEV_EMAIL;

  const { data: agent } = await sb.from("agents")
    .select("stripe_subscription_id, stripe_customer_id, stripe_numbers_item_id")
    .eq("id", user.id)
    .maybeSingle();

  if (!agent) return json({ error: "agent_not_found" }, 404);

  let accessUntil: string | null = null;

  // ── 1. Set Stripe subscription to cancel at period end ───────────────────
  if (!isDev && STRIPE_KEY && agent.stripe_subscription_id) {
    const stripeHdrs = {
      "Authorization": `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const cancelRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/${agent.stripe_subscription_id}`,
      {
        method: "POST",
        headers: stripeHdrs,
        body: new URLSearchParams({ "cancel_at_period_end": "true" }),
      },
    );
    if (!cancelRes.ok) {
      const err = await cancelRes.text();
      return json({ error: "stripe_cancel_failed", detail: err }, 502);
    }
    const sub = await cancelRes.json();
    if (sub.current_period_end) {
      accessUntil = new Date(sub.current_period_end * 1000).toISOString();
    }
  }

  // ── 2. Release all phone numbers from Telnyx + cancel per-number Stripe subscriptions ──
  const { data: numbers } = await sb.from("phone_numbers")
    .select("id, e164, stripe_sub_id")
    .eq("agent_id", user.id);

  const releasable = (numbers || []).filter(n => n.e164 !== TELNYX_DIALER_NUM);
  const releaseErrors: string[] = [];

  for (const num of releasable) {
    if (!isDev) {
      // Cancel the number's own Stripe subscription immediately.
      if (STRIPE_KEY && num.stripe_sub_id) {
        try {
          const res = await fetch(`https://api.stripe.com/v1/subscriptions/${num.stripe_sub_id}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${STRIPE_KEY}` },
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            if (body?.error?.code !== "resource_missing") {
              console.warn(`[stripe-cancel-subscription] Sub cancel failed for ${num.e164}:`, body);
            }
          }
        } catch (e) {
          console.warn(`[stripe-cancel-subscription] Sub cancel error for ${num.e164}:`, e.message);
        }
      }

      if (TELNYX_API_KEY) {
        try {
          await telnyxReleaseByE164(TELNYX_API_KEY, num.e164);
        } catch (e) {
          console.warn(`[stripe-cancel-subscription] Telnyx release failed for ${num.e164}:`, e.message);
          releaseErrors.push(`${num.e164}: ${e.message}`);
        }
      }
    }
    // Delete from DB regardless of outcome — plan subscription is ending.
    await sb.from("phone_numbers").delete().eq("id", num.id).eq("agent_id", user.id);
  }

  // ── 3. Clear caller ID and legacy numbers item on agents row ─────────────
  await sb.from("agents").update({
    signalwire_caller_id:   null,
    stripe_numbers_item_id: null,
  }).eq("id", user.id);

  return json({
    ok: true,
    access_until:     accessUntil,
    numbers_released: releasable.length,
    ...(releaseErrors.length ? { release_errors: releaseErrors } : {}),
  });
});
