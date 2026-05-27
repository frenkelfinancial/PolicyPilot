// ============================================================
// supabase/functions/signalwire-swml-outbound/index.ts
//
// Public SWML webhook. SignalWire executes this when a browser
// subscriber dials a PSTN number via @signalwire/js.
//
// ONLY NEEDED if your SignalWire space does not already allow
// subscribers to dial PSTN directly. If direct E.164 dialing
// works in the browser, you do not need to set this up.
//
// Setup (one-time in SignalWire dashboard):
//   1. Resources → SWML Scripts → Create new script
//   2. Set the handler URL to:
//        https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/signalwire-swml-outbound
//   3. Note the resource address (e.g. /private/outbound-pstn)
//   4. In the browser dialLead() function, change the `to` field to
//      use this address instead of the E.164 number if direct dialing fails.
//
// Required Supabase secrets:
//   SIGNALWIRE_CALLER_ID  — purchased number in E.164, e.g. +15551234567
//   SIGNALWIRE_API_TOKEN  — for signature validation
//
// Auth: PUBLIC (verify_jwt = false in config.toml).
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Validate the X-SignalWire-Signature header using the same HMAC-SHA1
// scheme as signalwire-call-status. Rejects unsigned requests.
async function isValidSignature(
  url: string,
  body: URLSearchParams,
  sigHeader: string,
  apiToken: string,
): Promise<boolean> {
  if (!sigHeader) return false;
  const sortedKeys = [...new Set(body.keys())].sort();
  let payload = url;
  for (const k of sortedKeys) {
    for (const v of body.getAll(k)) payload += k + v;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  if (expected.length !== sigHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHeader.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const callerId = Deno.env.get("SIGNALWIRE_CALLER_ID") ?? "";
  const apiToken = Deno.env.get("SIGNALWIRE_API_TOKEN") ?? "";

  if (!callerId) {
    console.error("[signalwire-swml-outbound] SIGNALWIRE_CALLER_ID not set");
    return swmlStop(CORS);
  }

  // Parse body (SignalWire sends JSON for SWML webhooks)
  let callTo = "";
  const rawBody = await req.text();
  try {
    const parsed = JSON.parse(rawBody);
    // Call Fabric passes call info under `call` key
    callTo = parsed?.call?.to ?? parsed?.to ?? "";
  } catch {
    // If form-encoded (LaML compat path)
    const form = new URLSearchParams(rawBody);
    callTo = form.get("To") ?? "";

    // Validate signature for LaML requests
    if (apiToken) {
      const sig = req.headers.get("x-signalwire-signature") ?? "";
      const ok = await isValidSignature(req.url, form, sig, apiToken);
      if (!ok) {
        console.warn("[signalwire-swml-outbound] bad signature, rejecting");
        return swmlStop(CORS);
      }
    }
  }

  // Validate destination looks like a phone number
  const digits = callTo.replace(/\D/g, "");
  if (!callTo || digits.length < 10) {
    console.warn("[signalwire-swml-outbound] invalid/missing destination:", callTo);
    return swmlStop(CORS);
  }

  const swml = {
    version: "1.0.0",
    sections: {
      main: [
        {
          connect: {
            to: callTo,
            from: callerId,
          },
        },
      ],
    },
  };

  console.log(`[signalwire-swml-outbound] routing to=${callTo} from=${callerId}`);
  return new Response(JSON.stringify(swml), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});

function swmlStop(cors: Record<string, string>) {
  return new Response(
    JSON.stringify({ version: "1.0.0", sections: { main: [{ stop: {} }] } }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
}
