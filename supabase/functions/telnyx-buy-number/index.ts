import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// DEPRECATED (wallet migration): numbers used to get their own dedicated
// Stripe subscription here (createNumberSubscription), billed monthly and
// tracked via phone_numbers.stripe_sub_id. That's replaced below by a
// one-time wallet_debit for the first 30 days at purchase time, then
// ongoing 30-day renewals via the wallet-renew-numbers cron function.
// stripe_sub_id is left on the table (unused for new purchases) so
// Cowork can cancel any live subscriptions from existing rows.

async function telnyxReleaseByE164(apiKey: string, e164: string): Promise<void> {
  const params = new URLSearchParams({ "filter[phone_number]": e164 });
  const listRes = await fetch(`https://api.telnyx.com/v2/phone_numbers?${params}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!listRes.ok) return;
  const listData = await listRes.json();
  const record = (listData.data || [])[0];
  if (!record) return;
  await fetch(`https://api.telnyx.com/v2/phone_numbers/${record.id}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${apiKey}` },
  }).catch(() => {});
}

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
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");
  const DEV_EMAIL      = "jacef8778099@gmail.com";

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: {
    e164?: string;
    friendly_name?: string | null;
    locality?: string | null;
    region?: string | null;
    number_type?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const e164 = body.e164;
  if (!e164 || !/^\+1\d{10}$/.test(e164)) {
    return json({ error: "invalid_number", detail: "Must be a US E.164 number like +14155551234" }, 400);
  }
  const numberType = body.number_type === "tollfree" ? "tollfree" : "local";

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const isDev = user.email === DEV_EMAIL;

  const { data: billingConfig } = await sb.from("billing_config")
    .select("number_local_mills, number_tollfree_mills")
    .eq("id", 1)
    .maybeSingle();
  const rateMills = numberType === "tollfree"
    ? (billingConfig?.number_tollfree_mills ?? 10000)
    : (billingConfig?.number_local_mills ?? 3000);

  // Numbers are billed to us immediately by Telnyx, so the wallet balance
  // must be checked here — not just gated client-side — before we ever
  // call Telnyx, or an authenticated session with $0 balance could
  // provision a number we can't recoup the cost of.
  if (!isDev) {
    const { data: wallet } = await sb.from("wallet_accounts")
      .select("balance_mills")
      .eq("agent_id", user.id)
      .maybeSingle();
    const balance = wallet?.balance_mills ?? 0;
    if (balance < rateMills) {
      return json({
        error:           "insufficient_balance",
        shortfall_mills: rateMills - balance,
        rate_mills:      rateMills,
      }, 402);
    }
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

  // If this is the agent's first number, auto-set it as primary so they can
  // call immediately without a manual "Set as Primary" step.
  // Also read the agent's global CNAM setting to auto-apply to the new number.
  const { data: agentRow } = await sb.from("agents")
    .select("signalwire_caller_id, cnam_name")
    .eq("id", user.id)
    .maybeSingle();
  const isFirstNumber = !agentRow?.signalwire_caller_id;
  const cnamName: string | null = agentRow?.cnam_name || null;

  const { data: insertedRow, error: insertErr } = await sb.from("phone_numbers").insert({
    agent_id:      user.id,
    e164,
    friendly_name: body.friendly_name || e164,
    locality:      body.locality  ?? null,
    region:        body.region    ?? null,
    sw_phone_sid:  telnyxPhoneSid,
    monthly_cost:  (rateMills / 1000).toFixed(2),
    number_type:   numberType,
    next_renewal_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    is_primary:    isFirstNumber,
    status:        "active",
    purchased_at:  new Date().toISOString(),
  }).select("id").single();

  if (insertErr || !insertedRow) {
    console.warn("[telnyx-buy-number] DB insert failed:", insertErr?.message);
    return json({ ok: false, error: "Purchase succeeded at Telnyx but failed to save to database: " + insertErr?.message }, 500);
  }

  // Debit the wallet for the first 30 days now that the number is on our
  // books. Developer account bypasses wallet billing entirely.
  if (!isDev) {
    const desc = numberType === "tollfree"
      ? `Toll-free number ${e164} — first 30 days @ $${(rateMills / 1000).toFixed(2)}`
      : `Local number ${e164} — first 30 days @ $${(rateMills / 1000).toFixed(2)}`;
    const { error: debitErr } = await sb.rpc("wallet_debit", {
      p_agent:        user.id,
      p_category:     numberType === "tollfree" ? "number_tollfree" : "number_local",
      p_units:        null,
      p_amount_mills: rateMills,
      p_ref_type:     "phone_number",
      p_ref_id:       insertedRow.id,
      p_desc:         desc,
    });

    if (debitErr) {
      // Rare race: balance dropped between the pre-check above and now
      // (e.g. a concurrent purchase). Never leave an unpaid number active —
      // unwind the DB row and release it back to Telnyx.
      console.warn("[telnyx-buy-number] wallet debit failed post-purchase, rolling back:", debitErr.message);
      await sb.from("phone_numbers").delete().eq("id", insertedRow.id);
      await telnyxReleaseByE164(TELNYX_API_KEY, e164);
      return json({ error: "insufficient_balance", detail: debitErr.message }, 402);
    }
  }

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

  if (isFirstNumber) {
    await sb.from("agents")
      .update({ signalwire_caller_id: e164 })
      .eq("id", user.id);
    console.log(`[telnyx-buy-number] Auto-set ${e164} as primary caller ID for agent ${user.id}`);
  }

  return json({ ok: true, e164, set_as_primary: isFirstNumber });
});
