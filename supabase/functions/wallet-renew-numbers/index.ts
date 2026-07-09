import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Service-role-only cron worker: renews every phone number whose
// next_renewal_at has passed by debiting the agent's wallet for another
// 30 days (local -> billing_config.number_local_mills, toll-free ->
// number_tollfree_mills). Advances next_renewal_at on success.
//
// If the wallet can't cover a renewal, the number is NOT released —
// it's marked status='past_due' with past_due_since set (first time
// only), a grace flag for Phase 3 to build low-balance notifications
// off of. It keeps being retried on every run until either the wallet
// is topped up (renewal succeeds, past_due clears) or a human decides to
// release it manually.
//
// Idempotent per number per period: a number is only ever picked up when
// next_renewal_at <= now(), and a successful renewal immediately pushes
// next_renewal_at forward, so re-running this function within the same
// period (e.g. because pg_cron fires hourly) never double-charges it.
//
// Scheduled via pg_cron + pg_net — see the cron.schedule(...) call wired
// up alongside this deploy. Authenticated with a dedicated WALLET_CRON_SECRET
// (not the service role key) so the cron job's Authorization header never
// needs to carry the all-powerful service role credential.
serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET  = Deno.env.get("WALLET_CRON_SECRET");

  const authHeader = req.headers.get("Authorization") || "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: billingConfig } = await sb.from("billing_config")
    .select("number_local_mills, number_tollfree_mills")
    .eq("id", 1)
    .maybeSingle();
  const localRateMills    = billingConfig?.number_local_mills    ?? 3000;
  const tollfreeRateMills = billingConfig?.number_tollfree_mills ?? 10000;

  const { data: dueNumbers, error: fetchErr } = await sb.from("phone_numbers")
    .select("id, agent_id, e164, number_type, next_renewal_at")
    .in("status", ["active", "past_due"])
    .eq("renew_from_wallet", true)
    .lte("next_renewal_at", new Date().toISOString());

  if (fetchErr) {
    console.error("[wallet-renew-numbers] fetch failed:", fetchErr.message);
    return new Response(JSON.stringify({ error: "fetch_failed", detail: fetchErr.message }), { status: 500 });
  }

  const results = { renewed: 0, past_due: 0, errors: 0 };

  for (const num of dueNumbers || []) {
    const rateMills = num.number_type === "tollfree" ? tollfreeRateMills : localRateMills;
    const desc = num.number_type === "tollfree"
      ? `Toll-free number ${num.e164} — 30-day renewal @ $${(rateMills / 1000).toFixed(2)}`
      : `Local number ${num.e164} — 30-day renewal @ $${(rateMills / 1000).toFixed(2)}`;

    const { error: debitErr } = await sb.rpc("wallet_debit", {
      p_agent:        num.agent_id,
      p_category:     num.number_type === "tollfree" ? "number_tollfree" : "number_local",
      p_units:        null,
      p_amount_mills: rateMills,
      p_ref_type:     "phone_number_renewal",
      p_ref_id:       num.id,
      p_desc:         desc,
    });

    if (debitErr) {
      // Insufficient balance (or any other debit failure) — mark past_due
      // but leave the number active and untouched otherwise. Don't stomp
      // past_due_since if it's already set from an earlier failed attempt.
      await sb.from("phone_numbers")
        .update({ status: "past_due", past_due_since: new Date().toISOString() })
        .eq("id", num.id)
        .is("past_due_since", null);
      console.warn(`[wallet-renew-numbers] renewal failed for ${num.e164}:`, debitErr.message);
      results.past_due++;
      continue;
    }

    // Success — advance the renewal window forward from whichever is
    // later (the old due date, or now). Using the old due date keeps
    // numbers renewed on schedule; using now() for numbers that were
    // past_due for a while prevents an immediate re-charge next run.
    const oldDue = new Date(num.next_renewal_at).getTime();
    const base   = Math.max(oldDue, Date.now());
    const nextRenewalAt = new Date(base + 30 * 24 * 60 * 60 * 1000).toISOString();

    await sb.from("phone_numbers")
      .update({ status: "active", past_due_since: null, next_renewal_at: nextRenewalAt })
      .eq("id", num.id);

    results.renewed++;
  }

  return new Response(JSON.stringify({ ok: true, ...results }), {
    headers: { "Content-Type": "application/json" },
  });
});
