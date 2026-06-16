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

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SIP_USERNAME       = Deno.env.get("TELNYX_SIP_USERNAME");
  const SIP_PASSWORD       = Deno.env.get("TELNYX_SIP_PASSWORD");
  const BROWSER_CALLER_ID  = Deno.env.get("TELNYX_BROWSER_CALLER_ID") || "";

  if (!SIP_USERNAME || !SIP_PASSWORD) {
    return json({
      error: "sip_not_configured",
      detail: "TELNYX_SIP_USERNAME or TELNYX_SIP_PASSWORD secret is missing.",
    }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  return json({
    ok:           true,
    sip_username: SIP_USERNAME,
    sip_password: SIP_PASSWORD,
    caller_id:    BROWSER_CALLER_ID,
  });
});
