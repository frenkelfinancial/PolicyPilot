// ============================================================
// supabase/functions/_shared/statement-email.ts
//
// Back Office Phase 1b: turning a forwarded carrier email into ingested
// commission statements.
//
// THE PAYLOAD SHAPE IS NOW OBSERVED, from a real delivery on 2026-07-29:
//
//   data: { cc, to, bcc, from, subject, email_id, created_at, message_id,
//           attachments, received_for }
//   data.attachments[]: { id, filename, content_id, content_type,
//                         content_disposition }
//
// **There is NO content field.** Resend's inbound webhook carries attachment
// METADATA ONLY; the bytes are fetched separately from
//   GET /emails/{email_id}/attachments/{attachment_id}
// The first guess — that inbound would mirror Resend's OUTBOUND
// `{filename, content}` shape — was wrong, and CAPTURE-FIRST is what made that
// a one-function fix rather than a lost statement.
//
// Capture-first remains the rule: every event is written VERBATIM to
// `inbound_statement_emails` before a single field is read out of it, so an
// unforeseen shape stays recoverable and re-runnable.
//
// The inline shapes are still accepted. They cost nothing, and a provider that
// starts inlining small attachments should not break us.
// ============================================================

/**
 * The domains that carry commission mail.
 *
 * PRIMARY is Resend's own receiving domain, which works on the FREE plan.
 * Registering `commissions.producerstackcrm.com` as its own Resend domain —
 * which is what receiving on a subdomain requires — needs their $20/mo Pro
 * plan, and that spend was deliberately declined on 2026-07-29.
 *
 * The branded domain stays in this list, dormant. Its MX record is live and
 * correct, so the day the plan is upgraded it starts working with NO code
 * change. That is the whole reason it is a list and not a constant.
 */
export const COMMISSION_EMAIL_PRIMARY = "ouintiicri.resend.app";
export const COMMISSION_EMAIL_BRANDED = "commissions.producerstackcrm.com";
export const COMMISSION_EMAIL_DOMAINS = [
  COMMISSION_EMAIL_PRIMARY,   // active, free plan
  COMMISSION_EMAIL_BRANDED,   // dormant until Resend Pro; MX already live
];

/** The address to SHOW an agent. Always the one that actually receives today. */
export function commissionAddressFor(token: string): string {
  return `${token}@${COMMISSION_EMAIL_PRIMARY}`;
}

/** True when this recipient is a commission forwarding address. */
export function isCommissionAddress(to: string): boolean {
  return extractCommissionToken(to) !== null;
}

/**
 * `<token>@<one of our domains>` -> token.
 *
 * Plus-addressing is stripped (`abc+anything@` -> `abc`) so an agent can tag a
 * forward without breaking the lookup, and the token is lower-cased because
 * the local part is case-insensitive in every mail client an agent will use.
 *
 * The domain check is EXACT. Resolving a token is what grants write access to
 * an agent's book, so `evil-ouintiicri.resend.app` and
 * `ouintiicri.resend.app.evil.com` must both fail.
 */
export function extractCommissionToken(to: unknown): string | null {
  const raw = String(to ?? "").trim().toLowerCase();
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/);
  const addr = angle ? angle[1] : raw;
  const at = addr.lastIndexOf("@");
  if (at < 1) return null;
  const domain = addr.slice(at + 1);
  if (!COMMISSION_EMAIL_DOMAINS.includes(domain)) return null;
  const local = addr.slice(0, at).split("+")[0];
  return /^[a-z0-9]{8,64}$/.test(local) ? local : null;
}

/** Every recipient on the event, across the shapes a provider might use. */
export function collectRecipients(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(push); return; }
    const e = v as { email?: unknown; address?: unknown };
    if (typeof e.email === "string") out.push(e.email);
    else if (typeof e.address === "string") out.push(e.address);
  };

  // `received_for` is Resend's own record of the address it accepted the mail
  // FOR — authoritative, and present even when our address is only in bcc
  // (which is how a forwarded carrier email often reaches us). It arrives
  // JSON-encoded: a string holding an array.
  const rf = data.received_for;
  if (typeof rf === "string" && rf.trim().startsWith("[")) {
    try { push(JSON.parse(rf)); } catch { push(rf); }
  } else {
    push(rf);
  }

  push(data.to);
  push(data.cc);
  push(data.bcc);
  push(data.recipient);
  push(data.recipients);
  return out;
}

export interface InboundAttachment {
  filename: string;
  /** Bytes, when the provider inlined them. Null means "fetch by remoteId". */
  contentBase64: string | null;
  /** Resend's attachment id — how the bytes are actually retrieved. */
  remoteId: string | null;
  contentType?: string | null;
  /** Which payload shape this came from, so drift is visible in the capture. */
  via: string;
}

const ATT_KEYS = ["attachments", "attachment", "files"];
const CONTENT_KEYS = ["content", "data", "content_base64", "contentBase64", "base64", "body"];
const NAME_KEYS = ["filename", "file_name", "fileName", "name"];

/**
 * Pull attachments out of the event.
 *
 * Handles BOTH the observed Resend shape (metadata + an `id` to fetch by) and
 * the inline shapes, and records which one applied in `via`.
 */
export function extractAttachments(data: Record<string, unknown>): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  for (const ak of ATT_KEYS) {
    const list = data[ak];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;

      let name = "";
      for (const nk of NAME_KEYS) {
        if (typeof o[nk] === "string" && o[nk]) { name = o[nk] as string; break; }
      }
      if (!name) continue;

      let content: string | null = null;
      let via = "";
      for (const ck of CONTENT_KEYS) {
        const v = o[ck];
        if (typeof v === "string" && v.length > 0) { content = v; via = `${ak}[].${ck}`; break; }
        if (v && Array.isArray(v)) {
          content = base64FromBytes(new Uint8Array(v as number[]));
          via = `${ak}[].${ck}(bytes)`;
          break;
        }
      }

      const remoteId = typeof o.id === "string" && o.id ? o.id : null;
      if (!content && !remoteId) continue;
      if (!content) via = `${ak}[].id(fetch)`;

      out.push({
        filename: name,
        contentBase64: content ? stripDataUrl(content) : null,
        remoteId,
        contentType: typeof o.content_type === "string" ? o.content_type
          : typeof o.contentType === "string" ? o.contentType
          : typeof o.type === "string" ? o.type : null,
        via,
      });
    }
    if (out.length) break;
  }
  return out;
}

/**
 * Fetch attachment bytes from Resend.
 *
 * Needs a FULL-ACCESS Resend API key. The key this app has stored is send-only
 * restricted, and every read endpoint returns `401 restricted_api_key` —
 * verified against all four plausible paths on 2026-07-29. A full-access key
 * is a free dashboard action, not a plan change.
 *
 * Returns a plain-English reason instead of throwing: the caller records it on
 * the capture row and still answers Resend 200. An email we have stored but
 * cannot yet read is recoverable; a retry storm is not.
 */
export async function fetchAttachmentBytes(
  emailId: string,
  attachmentId: string,
  apiKey: string,
): Promise<{ ok: true; base64: string } | { ok: false; reason: string }> {
  // THE REAL ENDPOINT, found by probing with a full-access key on 2026-07-29:
  //
  //   GET /emails/inbound/{email_id}/attachments/{attachment_id}
  //     -> { id, filename, content_type, size, download_url, expires_at }
  //
  // INBOUND emails live under /emails/inbound/, NOT /emails/. The first guess
  // (`/emails/{id}/attachments/{id}`) returned 404 "Email not found" — the
  // outbound collection genuinely does not contain them. Resend answers 405
  // method_not_allowed for a path that does not exist at all, which is what
  // made the difference between "wrong path" and "wrong id" legible.
  //
  // The bytes are then behind a SIGNED, EXPIRING CDN url which takes no auth
  // header of its own — sending one is harmless but pointless.
  const metaUrl = `https://api.resend.com/emails/inbound/${emailId}/attachments/${attachmentId}`;
  let res: Response;
  try {
    res = await fetch(metaUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (e) {
    return { ok: false, reason: `Could not reach Resend to download the attachment: ${String((e as Error).message ?? e)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: "Resend refused the attachment download: the stored API key is send-only. " +
        "A full-access Resend API key (free) is needed in RESEND_FULL_API_KEY.",
    };
  }
  if (!res.ok) return { ok: false, reason: `Resend returned ${res.status} for the attachment lookup.` };

  const ct = res.headers.get("content-type") || "";
  try {
    // A non-JSON answer means Resend handed us the bytes directly. Not the
    // shape observed today, but free to support.
    if (!ct.includes("json")) {
      return { ok: true, base64: base64FromBytes(new Uint8Array(await res.arrayBuffer())) };
    }

    const j = await res.json() as Record<string, unknown>;

    // Inline content, if it is ever offered.
    for (const k of CONTENT_KEYS) {
      const v = j[k];
      if (typeof v === "string" && v) return { ok: true, base64: stripDataUrl(v) };
    }

    // The observed path: follow the signed URL.
    const dl = (typeof j.download_url === "string" && j.download_url)
      ? j.download_url
      : (typeof j.url === "string" ? j.url : null);
    if (!dl) return { ok: false, reason: "Resend returned no download URL for the attachment." };

    const r2 = await fetch(dl);
    if (!r2.ok) {
      // `expires_at` is minutes away, so a stale URL is a real failure mode
      // rather than a theoretical one — say so plainly.
      return { ok: false, reason: `The attachment download URL returned ${r2.status} (it may have expired).` };
    }
    return { ok: true, base64: base64FromBytes(new Uint8Array(await r2.arrayBuffer())) };
  } catch (e) {
    return { ok: false, reason: `The attachment download could not be read: ${String((e as Error).message ?? e)}` };
  }
}

/** `data:text/csv;base64,AAAA` -> `AAAA`. Left alone when already bare. */
export function stripDataUrl(s: string): string {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(s.trim());
  return m ? m[1] : s.trim();
}

export function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The formats the ingestion pipeline can actually read. */
export const INGESTIBLE_EXT = ["pdf", "xlsx", "xls", "csv", "zip"];

export function isIngestibleFilename(name: string): boolean {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  return INGESTIBLE_EXT.includes(ext);
}

export interface InboundEmail {
  eventId: string | null;
  /** Resend's inbound email id — needed to fetch attachment bytes. */
  emailId: string | null;
  from: string;
  recipients: string[];
  token: string | null;
  toAddress: string | null;
  subject: string;
  attachments: InboundAttachment[];
  ingestible: InboundAttachment[];
  skipped: { filename: string; reason: string }[];
}

/**
 * The normalized view of an inbound event.
 *
 * Returns `null` only when there is no recipient at all — which is not a
 * commission email, it is a malformed event.
 */
export function parseInboundStatementEmail(payload: Record<string, unknown>): InboundEmail | null {
  const data = (payload?.data ?? payload) as Record<string, unknown>;
  if (!data || typeof data !== "object") return null;

  const recipients = collectRecipients(data);
  if (recipients.length === 0) return null;

  // The FIRST recipient that is a commission address wins. An agent who CCs
  // their forwarding address on a carrier email is a real case, and the
  // carrier's own address will be in `to` ahead of ours.
  let token: string | null = null;
  let toAddress: string | null = null;
  for (const r of recipients) {
    const t = extractCommissionToken(r);
    if (t) { token = t; toAddress = r; break; }
  }

  const fromRaw = data.from;
  const from = typeof fromRaw === "string" ? fromRaw : (fromRaw as { email?: string })?.email ?? "";

  const attachments = extractAttachments(data);
  const ingestible: InboundAttachment[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  for (const a of attachments) {
    if (isIngestibleFilename(a.filename)) ingestible.push(a);
    else skipped.push({ filename: a.filename, reason: "not a PDF, Excel, CSV or ZIP file" });
  }

  return {
    eventId: typeof payload?.id === "string" ? payload.id as string : null,
    emailId: typeof data.email_id === "string" ? data.email_id as string : null,
    from: String(from),
    recipients,
    token,
    toAddress,
    subject: typeof data.subject === "string" ? data.subject : "",
    attachments,
    ingestible,
    skipped,
  };
}

/** The status a capture row should carry, given what parsing found. */
export function captureStatus(email: InboundEmail | null, agentId: string | null): string {
  if (!email) return "failed";
  if (!agentId) return "unresolved";
  if (email.ingestible.length === 0) return "no_attachment";
  return "received";
}

/**
 * The one-line explanation stored on a capture row that produced nothing.
 * Written for a human reading the row six weeks later, not for a log.
 */
export function captureError(email: InboundEmail | null, agentId: string | null): string | null {
  if (!email) return "The inbound event could not be parsed at all. The raw payload is stored.";
  if (!agentId) {
    return email.token
      ? `No agent owns the forwarding address ${email.toAddress}. It may have been rotated or disabled.`
      : "This email was not addressed to a commission forwarding address.";
  }
  if (email.attachments.length === 0) {
    return "The email carried no attachment. Carrier statements arrive as a PDF, Excel, CSV or ZIP file.";
  }
  if (email.ingestible.length === 0) {
    return "No attachment was a readable statement: " +
      email.skipped.map((s) => `${s.filename} — ${s.reason}`).join("; ");
  }
  return null;
}
