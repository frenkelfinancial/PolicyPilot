// ============================================================
// supabase/functions/_shared/webhook-verify.ts
//
// Signature verification for the two providers messaging-delivery-webhook
// (and friends) receive callbacks from. Deno-only (crypto.subtle in the
// edge function runtime) — not exercised by the Node unit test suite.
// ============================================================

/**
 * Telnyx signs webhooks with Ed25519: headers `telnyx-signature-ed25519`
 * (base64 signature) and `telnyx-timestamp` (unix seconds). The signed
 * payload is `${timestamp}|${rawBody}`. Public key comes from the Telnyx
 * portal (Webhooks page) — base64, NOT the API key.
 */
export async function verifyTelnyxSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  publicKeyBase64: string,
): Promise<boolean> {
  if (!signatureHeader || !timestampHeader) return false;

  const keyBytes = Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0));
  const sigBytes = Uint8Array.from(atob(signatureHeader), (c) => c.charCodeAt(0));
  const signedPayload = new TextEncoder().encode(`${timestampHeader}|${rawBody}`);

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, sigBytes, signedPayload);
  } catch (err) {
    console.error("[webhook-verify] Ed25519 verify failed:", (err as Error)?.message || err);
    return false;
  }
}

/**
 * Resend webhooks are signed the Svix way: headers `svix-id`, `svix-timestamp`,
 * `svix-signature` (space-separated "v1,<base64 hmac>" values — accept any
 * match). Secret is the Resend webhook signing secret, "whsec_"-prefixed
 * base64. Signed content is `${svixId}.${svixTimestamp}.${rawBody}`, HMAC-SHA256.
 */
export async function verifyResendSignature(
  rawBody: string,
  svixId: string | null,
  svixTimestamp: string | null,
  svixSignatureHeader: string | null,
  signingSecret: string,
): Promise<boolean> {
  if (!svixId || !svixTimestamp || !svixSignatureHeader) return false;

  const secretB64 = signingSecret.startsWith("whsec_") ? signingSecret.slice(6) : signingSecret;
  const secretBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  // svix-signature header looks like "v1,base64sig v1,base64sig2 ..."
  const candidates = svixSignatureHeader.split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean);

  return candidates.includes(expected);
}

/**
 * Verify against ANY of our known Resend signing secrets, and say which one
 * matched.
 *
 * WHY THIS EXISTS. Resend issues a separate `whsec_` per endpoint, so we hold
 * two: RESEND_WEBHOOK_SECRET (delivery, webhook 86308238-…) and
 * RESEND_INBOUND_WEBHOOK_SECRET (inbound, webhook 06060a7c-…). Which value
 * landed in which Supabase secret has NEVER been confirmed against a real
 * event — no Resend webhook has successfully delivered to this app, because
 * both endpoints were auto-disabled on 2026-07-09 before one ever did.
 *
 * If those two values are swapped, every call to both endpoints returns 401,
 * Svix retries, and Resend disables them again — which is exactly the failure
 * being recovered from. Trying the endpoint's OWN secret first and the other
 * as a fallback removes that entire class of failure, and the returned
 * `matched` name makes a swap visible in the logs instead of silent.
 *
 * This is not a weakening: both secrets are ours, both are Resend-issued for
 * our own endpoints, and a forged request still has to produce a valid HMAC
 * under one of them. A genuine mismatch still fails closed.
 */
export async function verifyResendSignatureAny(
  rawBody: string,
  svixId: string | null,
  svixTimestamp: string | null,
  svixSignatureHeader: string | null,
  secrets: { name: string; value: string | undefined }[],
): Promise<{ ok: boolean; matched: string | null; tried: string[] }> {
  const tried: string[] = [];
  for (const s of secrets) {
    if (!s.value) continue;
    tried.push(s.name);
    try {
      if (await verifyResendSignature(rawBody, svixId, svixTimestamp, svixSignatureHeader, s.value)) {
        return { ok: true, matched: s.name, tried };
      }
    } catch (err) {
      // A malformed secret (bad base64) must not take the endpoint down with
      // a 500 — that is a retry storm and another auto-disable. Treat it as a
      // non-match and let the next candidate try.
      console.error(`[webhook-verify] secret ${s.name} unusable:`, (err as Error)?.message || err);
    }
  }
  return { ok: false, matched: null, tried };
}
