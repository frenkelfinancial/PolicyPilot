// ============================================================
// supabase/functions/_shared/email/cleaner.ts
//
// HTML -> plain-text cleaner + pre-extraction trimmer. Runs BEFORE any
// Claude call to strip the ~90% of a carrier email that is boilerplate
// (markup, tracking pixels, quoted reply chains, legal disclaimers, unsub
// footers) so the model sees only the data-bearing lines. Every byte removed
// here is an input token we don't pay for.
//
// Design rule: be aggressive on KNOWN boilerplate, conservative everywhere
// else. Never cut on a marker unless there's real content before it, so we
// can't accidentally blank out a whole body. Pure + dependency-free (Deno + Node).
// ============================================================

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", trade: "™", reg: "®", copy: "©", cent: "¢", pound: "£", euro: "€",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const key = body in NAMED_ENTITIES ? body : body.toLowerCase();
    return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : m;
  });
}

/**
 * Convert an HTML email body to readable plain text: drop non-content blocks
 * (script/style/head), turn block/line tags into newlines, strip remaining
 * tags, decode entities, and normalize whitespace.
 */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);

  // zero-width + BOM noise
  s = s.replace(/[​-‍﻿]/g, "");
  // comments (incl. Outlook conditional comments)
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // non-content blocks entirely
  s = s.replace(/<(script|style|head|title|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // images never carry data here (tracking pixels, logos) — drop with alt text
  s = s.replace(/<img\b[^>]*>/gi, " ");

  // closing / self-contained block tags -> newline
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol|blockquote)\s*>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  // opening block tags -> newline (keeps rows/paragraphs apart)
  s = s.replace(/<(p|div|tr|li|h[1-6]|table|ul|ol|blockquote)\b[^>]*>/gi, "\n");
  // table cells -> space so columns don't glue together
  s = s.replace(/<\/?td\b[^>]*>/gi, " ");
  s = s.replace(/<\/?th\b[^>]*>/gi, " ");

  // strip all remaining tags
  s = s.replace(/<[^>]+>/g, "");

  s = decodeEntities(s);

  // normalize whitespace: unify newlines, collapse intra-line runs, trim lines,
  // cap blank runs to a single blank line.
  s = s.replace(/\r\n?/g, "\n");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n");
  // collapse block-boundary blank lines to single newlines (tightest for tokens)
  s = s.replace(/\n{2,}/g, "\n");
  return s.trim();
}

// Sentinels that begin a quoted reply / forwarded chain. Everything from the
// earliest match to the end is dropped.
const QUOTE_SENTINELS: RegExp[] = [
  /^On .+ wrote:$/im, // Gmail/Apple "On <date>, <name> wrote:"
  /^-{2,}\s*Original Message\s*-{2,}/im, // Outlook
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^_{5,}$/m, // Outlook underscore divider before "From:" header
  /^From:\s.+\n(?:.*\n)?(?:Sent|Date):\s.+$/im, // reply header block
];

/** Remove quoted-reply and forwarded chains that add no new carrier data. */
export function stripQuotedReplies(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_SENTINELS) {
    const m = re.exec(text);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  let out = text.slice(0, cut);
  // also drop any leftover ">"-prefixed quoted lines
  out = out
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// Phrases that reliably begin a legal disclaimer / unsubscribe / footer block.
// Match is case-insensitive; we cut from the earliest one that has real
// content before it.
const FOOTER_SENTINELS: RegExp[] = [
  /confidentiality notice/i,
  /this (?:e-?mail|message|communication)(?: and any attachments)?(?: is| are| may)/i,
  /the information (?:contained|transmitted) in this/i,
  /if you (?:are|received this)[^.\n]*not the intended recipient/i,
  /please consider the environment before printing/i,
  /this is an automated message[^.\n]*do not reply/i,
  /view this email in your browser/i,
  /you (?:are receiving|have received) this(?: email)? because/i,
  /^\s*unsubscribe\b/im,
  /to unsubscribe/i,
  /manage (?:your )?(?:email )?preferences/i,
  /©\s?\d{4}/,
];

/** Truncate a body at the first legal/marketing footer sentinel. */
export function stripDisclaimers(text: string): string {
  let cut = text.length;
  for (const re of FOOTER_SENTINELS) {
    const m = re.exec(text);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).replace(/\n{3,}/g, "\n\n").trim();
}

export interface TrimOptions {
  /** Hard character cap after trimming (~4 chars/token). Default 8000 (~2k tok). */
  maxChars?: number;
  stripQuotes?: boolean; // default true
  stripFooters?: boolean; // default true
}

/**
 * Full pre-extraction pipeline: HTML -> text -> drop quoted replies -> drop
 * disclaimers/footers -> cap length. This is what the parser feeds to Haiku.
 * Accepts already-plain text too (htmlToText is a no-op on tagless input).
 */
export function trimForExtraction(input: string | null | undefined, opts: TrimOptions = {}): string {
  const { maxChars = 8000, stripQuotes = true, stripFooters = true } = opts;
  let s = htmlToText(input);
  if (stripQuotes) s = stripQuotedReplies(s);
  if (stripFooters) s = stripDisclaimers(s);
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > maxChars) {
    s = s.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n…[truncated]";
  }
  return s;
}
