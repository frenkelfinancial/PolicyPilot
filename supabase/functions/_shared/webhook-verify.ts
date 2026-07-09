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
