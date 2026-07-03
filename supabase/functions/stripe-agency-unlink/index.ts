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

// Unlinks an agency_invites row (leader removing an agent, or an agent
// revoking a leader's access) and, if the agent has no other accepted
// agency link left, removes their 20% downline discount from Stripe so
// future invoices go back to full price.
//
// Body:
//   invite_id — uuid of the agency_invites row
//   mode      — "remove" (leader-initiated) | "revoke" (agent-initiated)
//
// REQUIRED Supabase secrets:
//   STRIPE_SECRET_KEY
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const STRIPE_KEY   = Deno.env.get("STRIPE_SECRET_KEY");

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  const body     = await req.json().catch(() => ({}));
  const inviteId = body.invite_id as string | undefined;
  const mode     = body.mode as string | undefined;
  if (!inviteId || (mode !== "remove" && mode !== "revoke")) {
    return json({ error: "bad_request" }, 400);
  }

  const { data: invite, error: inviteErr } = await sb
    .from("agency_invites").select("*").eq("id", inviteId).maybeSingle();
  if (inviteErr || !invite) return json({ error: "invite_not_found" }, 404);

  if (mode === "remove" && invite.leader_id !== user.id) {
    return json({ error: "forbidden" }, 403);
  }
  if (mode === "revoke" && (invite.invitee_email || "").toLowerCase() !== (user.email || "").toLowerCase()) {
    return json({ error: "forbidden" }, 403);
  }

  if (mode === "remove") {
    const { error } = await sb.from("agency_invites").delete().eq("id", inviteId);
    if (error) return json({ error: "delete_failed", detail: error.message }, 500);
  } else {
    const { error } = await sb.from("agency_invites")
      .update({ status: "declined", invitee_id: null }).eq("id", inviteId);
    if (error) return json({ error: "update_failed", detail: error.message }, 500);
  }

  // Only strip the Stripe discount if the invitee has no other accepted
  // agency link (they may belong to more than one leader's agency).
  const inviteeId = invite.invitee_id as string | null;
  if (inviteeId && STRIPE_KEY) {
    const { data: stillLinked } = await sb
      .from("agency_invites")
      .select("id").eq("invitee_id", inviteeId).eq("status", "accepted").limit(1);
    if (!stillLinked || !stillLinked.length) {
      const { data: agentRow } = await sb
        .from("agents").select("stripe_subscription_id").eq("id", inviteeId).maybeSingle();
      if (agentRow?.stripe_subscription_id) {
        await fetch(`https://api.stripe.com/v1/subscriptions/${agentRow.stripe_subscription_id}/discount`, {
          method: "DELETE",
          headers: { "Authorization": `Bearer ${STRIPE_KEY}` },
        }).catch(() => {});
      }
    }
  }

  return json({ ok: true });
});
