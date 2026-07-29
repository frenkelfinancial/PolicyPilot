// ============================================================
// supabase/functions/_shared/statement-email.ts
//
// Back Office Phase 1b: turning a forwarded carrier email into ingested
// commission statements.
//
// CAPTURE FIRST, PARSE SECOND. The Resend `email.received` payload shape has
// never been seen by this codebase — messaging-email-inbound-webhook says so
// in its own header, because it was written before the inbound MX existed. So
// every event is written VERBATIM to `inbound_statement_emails` before a
// single field is read out of it. If the adapter below reads the wrong key for
// attachments, no statement is lost: the emails are all still there and can be
// re-run without asking an agent to forward anything again.
//
// This module is deliberately TOLERANT about field names and STRICT about
// what it claims. It tries the shapes Resend plausibly uses, records which one
// matched, and when none match it stores the email with status
// 'no_attachment' and an error saying exactly that — rather than guessing.
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
 * change: mail to either address resolves the same token the same way. That
 * is the whole reason it is a list and not a constant.
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
 * `<token>@commissions.producerstackcrm.com` -> token.
 *
 * Plus-addressing is stripped (`abc+anything@` -> `abc`) so an agent can tag a
 * forward without breaking the lookup, and the token is lower-cased because
 * the local part of an address is case-insensitive in every mail client an
 * agent will actually use.
 */
export function extractCommissionToken(to: unknown): string | null {
  const raw = String(to ?? "").trim().toLowerCase();
  if (!raw) return null;
  // Accept a bare address or a display-name form: "Name <addr@host>".
  const angle = raw.match(/<([^>]+)>/);
  const addr = angle ? angle[1] : raw;
  const at = addr.lastIndexOf("@");
  if (at < 1) return null;
  const domain = addr.slice(at + 1);
  if (!COMMISSION_EMAIL_DOMAINS.includes(domain)) return null;
  const local = addr.slice(0, at).split("+")[0];
  return /^[a-z0-9]{8,64}$/.test(local) ? local : null;
}

/** Every recipient on the event, across the shapes Resend might use. */
export function collectRecipients(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(push); return; }
    const e = (v as { email?: unknown; address?: unknown });
    if (typeof e.email === "string") out.push(e.email);
    else if (typeof e.address === "string") out.push(e.address);
  };
  push(data.to);
  push(data.cc);
  push((data as Record<string, unknown>).recipient);
  push((data as Record<string, unknown>).recipients);
  return out;
}

export interface InboundAttachment {
  filename: string;
  contentBase64: string;
  contentType?: string | null;
  /** Which payload shape this came from — recorded so the real one is learned. */
  via: string;
}

const ATT_KEYS = ["attachments", "attachment", "files"];
const CONTENT_KEYS = ["content", "data", "content_base64", "contentBase64", "base64", "body"];
const NAME_KEYS = ["filename", "file_name", "fileName", "name"];

/**
 * Pull attachments out of whatever shape arrived.
 *
 * Resend's documented outbound attachment shape is
 * `{ filename, content }` with content base64, and the inbound event is
 * expected to mirror it — but "expected" is not "verified", so several
 * plausible key names are tried and the one that worked is recorded on each
 * attachment as `via`. That string goes into the capture row, which is how the
 * real shape gets learned from the first genuine delivery instead of from a
 * guess.
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
      let content = "";
      let via = "";
      for (const ck of CONTENT_KEYS) {
        const v = o[ck];
        if (typeof v === "string" && v.length > 0) { content = v; via = `${ak}[].${ck}`; break; }
        // Some providers nest as { data: { data: "..." } } or send a byte array.
        if (v && typeof v === "object" && Array.isArray(v)) {
          content = base64FromBytes(new Uint8Array(v as number[]));
          via = `${ak}[].${ck}(bytes)`;
          break;
        }
      }
      if (!name || !content) continue;
      out.push({
        filename: name,
        contentBase64: stripDataUrl(content),
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
  const clean = b64.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The filenames the ingestion pipeline can actually read. */
export const INGESTIBLE_EXT = ["pdf", "xlsx", "xls", "csv", "zip"];

export function isIngestibleFilename(name: string): boolean {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  return INGESTIBLE_EXT.includes(ext);
}

/**
 * The normalized view of an inbound event.
 *
 * Returns `null` only when there is no recipient at all — which is not a
 * commission email, it is a malformed event.
 */
export interface InboundEmail {
  eventId: string | null;
  from: string;
  recipients: string[];
  token: string | null;
  toAddress: string | null;
  subject: string;
  attachments: InboundAttachment[];
  ingestible: InboundAttachment[];
  skipped: { filename: string; reason: string }[];
}

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
  const from = typeof fromRaw === "string"
    ? fromRaw
    : (fromRaw as { email?: string })?.email ?? "";

  const attachments = extractAttachments(data);
  const ingestible: InboundAttachment[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  for (const a of attachments) {
    if (isIngestibleFilename(a.filename)) ingestible.push(a);
    else skipped.push({ filename: a.filename, reason: "not a PDF, Excel, CSV or ZIP file" });
  }

  return {
    eventId: typeof payload?.id === "string" ? payload.id as string : null,
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
 *
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
