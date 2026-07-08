// ============================================================
// supabase/functions/_shared/crypto.ts
//
// App-level AES-256-GCM used to (a) encrypt Gmail refresh tokens at rest and
// (b) seal the OAuth `state` parameter so the callback can trust which user
// started the flow without a DB round-trip.
//
// The 32-byte key lives ONLY in the TOKEN_ENC_KEY edge-function secret — never
// in the DB or the repo. Accepts the key as standard base64 (44 chars) or hex
// (64 chars). Generate one with:  openssl rand -base64 32
//
// Wire format for every ciphertext: iv(12) ‖ ciphertext ‖ gcm-tag(16), then
// base64url so it is safe in both a DB text column and a URL query param.
// ============================================================

function decodeKey(raw: string | undefined): Uint8Array {
  if (!raw) throw new Error("TOKEN_ENC_KEY not set");
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    // hex
    bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  } else {
    // base64 / base64url
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  if (bytes.length !== 32) {
    throw new Error(`TOKEN_ENC_KEY must decode to 32 bytes (got ${bytes.length})`);
  }
  return bytes;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(): Promise<CryptoKey> {
  const raw = decodeKey(Deno.env.get("TOKEN_ENC_KEY"));
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a UTF-8 string → base64url(iv‖ct‖tag). */
export async function encryptString(plaintext: string): Promise<string> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

/** Inverse of encryptString. Throws if the tag fails (tampered/wrong key). */
export async function decryptString(token: string): Promise<string> {
  const key = await importKey();
  const buf = b64urlDecode(token);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** Seal a small JSON object into an authenticated, URL-safe token. */
export async function sealJson(obj: unknown): Promise<string> {
  return await encryptString(JSON.stringify(obj));
}

/** Open a token produced by sealJson. Throws on tamper / wrong key. */
export async function openJson<T = unknown>(token: string): Promise<T> {
  return JSON.parse(await decryptString(token)) as T;
}
