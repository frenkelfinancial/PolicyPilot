// ============================================================
// compliance-page.ts — PROMPT_16 Phases 2/3.
//
// Slug derivation + the server-side HTML renderers for an agent's public
// compliance pages (/a/:slug, /a/:slug/privacy-policy, /a/:slug/terms) and,
// since the campaign rejection, the hosted SMS opt-in form
// (/a/:slug/sms-opt-in) that collects our own consent instead of relying on
// a lead vendor's — see the block above renderSmsOptInPage().
//
// WHY THIS FEATURE EXISTS: 10DLC brand + campaign registration requires a
// publicly reachable privacy policy and terms page belonging to the business
// that sends the messages. Our agents are life insurance producers — most
// have no consumer-facing website, and the lead vendor's policy describes
// the VENDOR's business, not the agency's. A carrier reviewer is answering
// one question: "if I'm the consumer receiving this text, where do I learn
// who has my number and how to stop it?" These pages answer it.
//
// THREE RULES THAT ARE NOT STYLE PREFERENCES:
//
//   1. NO CLIENT-SIDE JAVASCRIPT, ANYWHERE. Not for the year in the footer,
//      not for a nav toggle, not for anything. Some carrier reviewers use
//      fetchers that never run JS. If required text is not in the raw HTML
//      response body, for those reviewers it does not exist. Every renderer
//      here returns a complete document with zero <script> tags.
//
//   2. THE MOBILE-INFORMATION PARAGRAPH IS VERBATIM. MOBILE_INFO_PARAGRAPH
//      below is the exact language carrier reviewers search for, sometimes
//      by literal string match. Do not paraphrase it, reflow it, split it
//      across elements, or "improve" it. It renders as one <p>.
//
//   3. THE PAGE BELONGS TO THE AGENT, NOT TO US. Their agency name is the
//      headline; their address and phone are the contact block. ProducerStack
//      appears only in one small footer line. Branding these as ProducerStack
//      pages recreates the exact "this policy describes a different business"
//      mismatch that made this feature necessary.
//
// Everything here is pure (no I/O, no Deno APIs) so it can be unit-tested
// under `node --test` — see compliance-page.test.ts.
// ============================================================

import { joinVendorNames, resolveVendorNames } from "./lead-vendors.ts";
import { buildOptInAutoResponse, buildOptInDisclosure } from "./sms-optin.ts";

// The disclosure and the confirmation text live in sms-optin.ts because
// lead-vendors.ts quotes them verbatim inside the campaign description and
// importing them from here would make a cycle. Re-exported so callers of
// this module (the compliance-page function, the tests) see one surface.
export { buildOptInAutoResponse, buildOptInDisclosure };

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export interface AgencyProfile {
  dba_name: string | null;
  business_legal_name: string | null;
  /** llc | corporation | s_corporation | partnership | sole_proprietor */
  business_entity_type: string | null;
  /** 2-letter state of formation. Drives entity language only. */
  formation_state: string | null;
  business_street: string | null;
  business_city: string | null;
  business_state: string | null;
  business_postal_code: string | null;
  business_phone: string | null;
  business_email: string | null;
  lead_vendors: string[] | null;
  compliance_slug: string | null;
  compliance_page_published_at: string | null;
}

export type CompliancePageKind = "index" | "privacy" | "terms" | "sms-opt-in";

// ------------------------------------------------------------
// The verbatim paragraph. See rule 2 in the header.
// ------------------------------------------------------------

export const MOBILE_INFO_PARAGRAPH =
  "Your mobile information will not be sold or shared with third parties for promotional or marketing purposes. " +
  "No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. " +
  "Information sharing to subcontractors in support services, such as customer service and messaging delivery " +
  "providers, is permitted. All other use case categories exclude text messaging originator opt-in data and " +
  "consent; this information will not be shared with any third parties.";

// ------------------------------------------------------------
// Slug derivation
// ------------------------------------------------------------

/**
 * Derive a URL slug from an agency name.
 *
 * Rules (PROMPT_16 Phase 2): lowercase, strip accents and punctuation,
 * spaces -> hyphens, collapse repeats, trim to 60 chars.
 *
 * Trailing hyphens are trimmed AFTER the length cut, so a name that happens
 * to break on a word boundary at char 60 doesn't produce "...agency-".
 * Returns "" for input with no usable characters — callers must handle that
 * (the DB function falls back to `agent-<uuid prefix>`).
 */
export function slugifyAgencyName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")                        // decompose accents: é -> e + U+0301
    .replace(/[̀-ͯ]/g, "")         // drop the combining marks
    // Letters NFD does NOT decompose, so they need explicit folds. The SQL
    // side (public.compliance_slugify) handles this exact set — the two
    // implementations must agree or an agent previews one URL and registers
    // another.
    .replace(/ø/g, "o")                 // ø
    .replace(/[đð]/g, "d")         // đ, ð
    .replace(/ł/g, "l")                 // ł
    .replace(/æ/g, "ae")                // æ
    .replace(/œ/g, "oe")                // œ
    .replace(/ß/g, "ss")                // ß
    .replace(/þ/g, "th")                // þ
    .replace(/&/g, " and ")                  // "Smith & Sons" -> "smith and sons"
    .replace(/['’]/g, "")          // O'Brien / O’Brien -> obrien, not o-brien
    .replace(/[^a-z0-9]+/g, "-")             // everything else becomes a separator
    .replace(/-+/g, "-")                     // collapse repeats
    .replace(/^-|-$/g, "")                   // trim
    .slice(0, 60)
    .replace(/-+$/, "");                     // re-trim after the length cut
}

/** A slug is well-formed if slugifying it is a no-op. Used by the DB check + router. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 60;
}

// ------------------------------------------------------------
// Required-field validation (Phase 4: "show exactly which one")
// ------------------------------------------------------------

export interface MissingField {
  /** Column name — also the anchor the Settings UI links to. */
  field: string;
  /** Human label shown in the UI. */
  label: string;
}

const REQUIRED_FIELDS: Array<{ field: keyof AgencyProfile; label: string }> = [
  { field: "business_street", label: "Street address" },
  { field: "business_city", label: "City" },
  { field: "business_state", label: "State" },
  { field: "business_postal_code", label: "ZIP code" },
  { field: "business_phone", label: "Business phone" },
  { field: "business_email", label: "Business email" },
];

/**
 * Which required fields are still empty. Empty array = ready to publish.
 * The business name check accepts EITHER dba_name or business_legal_name,
 * because a sole proprietor legitimately has no registered legal entity.
 */
export function missingComplianceFields(p: Partial<AgencyProfile>): MissingField[] {
  const missing: MissingField[] = [];
  const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;

  if (!filled(p.dba_name) && !filled(p.business_legal_name)) {
    missing.push({ field: "dba_name", label: "Business name" });
  }
  for (const r of REQUIRED_FIELDS) {
    if (!filled(p[r.field])) missing.push({ field: r.field, label: r.label });
  }
  return missing;
}

// ------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------

/**
 * Escape for HTML text and double-quoted attribute contexts.
 * Every interpolation below goes through this — agency names contain
 * apostrophes and ampersands as a matter of routine, and a name is
 * user-controlled input reaching an unauthenticated public page.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** "WI" -> "Wisconsin". Unknown/partial input passes through unchanged. */
export function stateName(code: string | null | undefined): string {
  if (!code) return "";
  const trimmed = code.trim();
  return US_STATES[trimmed.toUpperCase()] || trimmed;
}

/** ISO timestamp -> "July 29, 2026". Rendered server-side; never a JS Date in the page. */
export function formatLongDate(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  }).format(d);
}

/** Display form for a stored E.164 number: "+15551234567" -> "(555) 123-4567". */
export function formatPhoneDisplay(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return String(phone);
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

/** `tel:` href — always the E.164 form, never the punctuated display form. */
function telHref(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(phone).trim();
}

/** Public-facing agency name: DBA first, legal name as fallback. */
export function agencyDisplayName(p: Partial<AgencyProfile>): string {
  const dba = (p.dba_name || "").trim();
  if (dba) return dba;
  return (p.business_legal_name || "").trim();
}

/**
 * The entity clause used in the terms page and the policy's "who we are".
 *
 * Sole proprietors get "" — many of our agents have no LLC, and asserting
 * "a Wisconsin limited liability company" for a producer who never formed
 * one is a false statement on a compliance document.
 */
export function entityClause(p: Partial<AgencyProfile>): string {
  const type = (p.business_entity_type || "").trim().toLowerCase();
  const st = stateName(p.formation_state || p.business_state);
  if (!type || type === "sole_proprietor" || type === "none") return "";
  const noun = type === "llc"
    ? "limited liability company"
    : type === "corporation" || type === "s_corporation"
    ? "corporation"
    : type === "partnership"
    ? "partnership"
    : "";
  if (!noun) return "";
  return st ? `a ${st} ${noun}` : `a ${noun}`;
}

/** "Frenkel Financial LLC, doing business as Frenkel Financial Agency" — or just the one name. */
function legalNameClause(p: Partial<AgencyProfile>): string {
  const legal = (p.business_legal_name || "").trim();
  const dba = (p.dba_name || "").trim();
  if (legal && dba && legal.toLowerCase() !== dba.toLowerCase()) {
    return `${legal}, doing business as ${dba}`;
  }
  return legal || dba;
}

function cityStateZip(p: Partial<AgencyProfile>): string {
  const city = (p.business_city || "").trim();
  const st = (p.business_state || "").trim().toUpperCase();
  const zip = (p.business_postal_code || "").trim();
  const left = [city, st].filter(Boolean).join(", ");
  return [left, zip].filter(Boolean).join(" ");
}

// ------------------------------------------------------------
// Shared document shell
// ------------------------------------------------------------

// Deliberately restrained and document-like. This should read as an
// agency's own legal page, not as a SaaS marketing site — see rule 3.
// `color-scheme: light` is explicit so a reviewer's forced-dark browser
// doesn't invert the document into something that looks broken.
const BASE_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:light}
body{margin:0;background:#f6f7f9;color:#1c2024;
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 64px}
header.masthead{border-bottom:2px solid #1c2024;padding-bottom:20px;margin-bottom:32px}
h1{font-size:28px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
.tagline{margin:0;color:#5b636b;font-size:15px}
h2{font-size:20px;line-height:1.3;margin:36px 0 10px;letter-spacing:-.005em}
h3{font-size:16px;margin:24px 0 6px}
p,li{font-size:16px}
p{margin:0 0 14px}
ul{margin:0 0 14px;padding-left:22px}
li{margin:0 0 7px}
a{color:#1a4fa0}
a:hover{color:#123c7a}
.updated{display:inline-block;margin:0 0 24px;padding:5px 11px;background:#e9ecf1;
  border-radius:4px;font-size:13px;color:#464e57}
.card{background:#fff;border:1px solid #dfe3e8;border-radius:8px;padding:22px 24px;margin:0 0 24px}
.card h2{margin-top:0}
address{font-style:normal;line-height:1.7}
.docnav{margin:0 0 28px;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:10px}
.docnav a{display:inline-block;padding:9px 15px;background:#fff;border:1px solid #cfd5dc;
  border-radius:6px;text-decoration:none;color:#1c2024;font-size:15px}
.docnav a:hover{border-color:#1a4fa0;color:#1a4fa0}
.verbatim{background:#fff;border-left:4px solid #1c2024;padding:16px 18px;margin:0 0 18px}
.kv{margin:0}
.kv dt{font-weight:600;margin:14px 0 2px}
.kv dd{margin:0 0 2px}
/* Opt-in form. Native controls only — no JS validates anything here, the
   server re-checks every field, and the required attribute is a browser
   convenience rather than the check that matters. */
.field{margin:0 0 16px}
.field label{display:block;font-weight:600;font-size:14px;margin:0 0 5px}
.field input[type=text],.field input[type=tel]{width:100%;padding:11px 12px;font:16px/1.4 inherit;
  color:#1c2024;background:#fff;border:1px solid #b9c0c8;border-radius:6px}
.field input:focus{outline:2px solid #1a4fa0;outline-offset:1px;border-color:#1a4fa0}
.hint{margin:5px 0 0;font-size:13px;color:#5b636b}
.consent{display:flex;align-items:flex-start;gap:12px;background:#fff;border:1px solid #cfd5dc;
  border-radius:8px;padding:16px 18px;margin:0 0 20px}
.consent input[type=checkbox]{flex:0 0 auto;width:20px;height:20px;margin:2px 0 0}
.consent .disclosure{font-size:14px;line-height:1.6;margin:0}
button.submit{display:inline-block;padding:13px 26px;font:600 16px/1 inherit;color:#fff;
  background:#1c2024;border:1px solid #1c2024;border-radius:6px;cursor:pointer}
button.submit:hover{background:#000}
.errbox{background:#fdecec;border:1px solid #e5a5a5;border-left:4px solid #b62828;
  border-radius:6px;padding:14px 16px;margin:0 0 22px;color:#7d1d1d}
.errbox p{margin:0;font-size:15px}
/* Honeypot: off-screen rather than display:none so a bot reading the DOM
   still sees a fillable field. Never focusable, never announced. */
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
footer{margin-top:48px;padding-top:18px;border-top:1px solid #dfe3e8;
  font-size:13px;color:#6b737b}
footer p{margin:0 0 6px;font-size:13px}
@media (max-width:600px){
  .wrap{padding:24px 16px 48px}
  h1{font-size:23px}
  h2{font-size:18px}
  .card{padding:18px 16px}
}
`.trim();

interface ShellOptions {
  title: string;
  description: string;
  bodyHtml: string;
  agencyName: string;
  canonical?: string;
}

function documentShell(o: ShellOptions): string {
  // <meta name="robots" content="index,follow"> is deliberate: an indexable
  // page reads as a real business. A noindex compliance page invites the
  // question of why it's hidden.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="index,follow">
<meta name="description" content="${escapeHtml(o.description)}">
${o.canonical ? `<link rel="canonical" href="${escapeHtml(o.canonical)}">\n` : ""}<title>${escapeHtml(o.title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="wrap">
${o.bodyHtml}
<footer>
<p>This page is hosted by ProducerStack on behalf of ${escapeHtml(o.agencyName)}.</p>
</footer>
</div>
</body>
</html>`;
}

function contactBlock(p: AgencyProfile): string {
  const name = agencyDisplayName(p);
  const phone = (p.business_phone || "").trim();
  const email = (p.business_email || "").trim();
  return `<address>
<strong>${escapeHtml(name)}</strong><br>
${escapeHtml((p.business_street || "").trim())}<br>
${escapeHtml(cityStateZip(p))}<br>
${phone ? `Phone: <a href="tel:${escapeHtml(telHref(phone))}">${escapeHtml(formatPhoneDisplay(phone))}</a><br>` : ""}
${email ? `Email: <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : ""}
</address>`;
}

function docNav(slug: string, current: CompliancePageKind, prefix = ""): string {
  const items: Array<{ kind: CompliancePageKind; href: string; label: string }> = [
    { kind: "index", href: `${prefix}/a/${slug}`, label: "Overview" },
    { kind: "privacy", href: `${prefix}/a/${slug}/privacy-policy`, label: "Privacy Policy" },
    { kind: "terms", href: `${prefix}/a/${slug}/terms`, label: "Terms of Service" },
    { kind: "sms-opt-in", href: `${prefix}/a/${slug}/sms-opt-in`, label: "Text Message Opt-In" },
  ];
  return `<ul class="docnav">${
    items
      .filter((i) => i.kind !== current)
      .map((i) => `<li><a href="${escapeHtml(i.href)}">${escapeHtml(i.label)}</a></li>`)
      .join("")
  }</ul>`;
}

// The SMS program terms appear on BOTH pages by design: a reviewer may land
// on either one directly, and the terms page is required to mirror the
// policy's messaging disclosures.
function smsProgramSection(agency: string): string {
  return `<p>${escapeHtml(agency)} sends text messages only to consumers who have provided prior
express written consent. Messages we send include quote follow-up, appointment reminders,
application and policy status updates, and customer service replies.</p>
<ul>
<li><strong>Message frequency varies.</strong> We do not send on a fixed schedule; volume depends on
where you are in the quoting or application process.</li>
<li><strong>Message and data rates may apply.</strong> Your mobile carrier's standard rates apply to
messages you send and receive.</li>
<li><strong>Consent is not a condition of purchase.</strong> You are never required to agree to receive
text messages in order to buy insurance from us.</li>
<li><strong>To opt out, reply STOP</strong> to any message. You will receive one confirmation, and we
will not text you again.</li>
<li><strong>To resubscribe, reply START.</strong></li>
<li><strong>For help, reply HELP</strong> or contact us using the details below.</li>
<li>Carriers are not liable for delayed or undelivered messages.</li>
</ul>`;
}

// ------------------------------------------------------------
// Page renderers
// ------------------------------------------------------------

export interface RenderOptions {
  profile: AgencyProfile;
  /** Latest compliance_page_revisions.rendered_at (falls back to published_at). */
  lastUpdatedIso: string | null;
  /** Public origin, e.g. "https://trust.producerstackcrm.com". Used for canonical URLs. */
  baseUrl: string;
  /**
   * Path segment in front of `/a/:slug` for in-page links and the opt-in
   * form's action. Empty behind the trust.producerstackcrm.com rewrite (the
   * live shape); "/functions/v1/compliance-page" when the function is hit
   * directly, which is what `curl` verification and the fallback path do.
   * Defaults to "" so existing callers and rendered output are unchanged.
   */
  pathPrefix?: string;
}

export function renderIndexPage(o: RenderOptions): string {
  const p = o.profile;
  const slug = p.compliance_slug || "";
  const pfx = o.pathPrefix || "";
  const agency = agencyDisplayName(p);
  const entity = entityClause(p);
  const legal = legalNameClause(p);
  const updated = formatLongDate(o.lastUpdatedIso ?? p.compliance_page_published_at);

  const body = `<header class="masthead">
<h1>${escapeHtml(agency)}</h1>
<p class="tagline">Licensed life insurance agency${
    // Escape the state name, NOT the separator — running the whole string
    // through escapeHtml turns &middot; into &amp;middot; and the reviewer
    // sees the literal text "&middot;" on the page.
    p.business_state ? ` &middot; ${escapeHtml(stateName(p.business_state))}` : ""
  }</p>
</header>

<p class="updated">Last updated ${escapeHtml(updated)}</p>

<p>${escapeHtml(agency)} is a licensed life insurance agency${entity ? `, ${escapeHtml(entity)},` : ""}
serving individuals and families seeking life insurance coverage. We help clients compare policies from
multiple insurance carriers, complete applications, and service their coverage after it is issued.</p>

${docNav(slug, "index", pfx)}

<div class="card">
<h2>Contact us</h2>
${contactBlock(p)}
</div>

<div class="card">
<h2>Text messaging</h2>
<p>We send text messages only to people who have given prior express written consent to be contacted.
Reply <strong>STOP</strong> to any message to opt out, <strong>START</strong> to resubscribe, or
<strong>HELP</strong> for assistance. Message and data rates may apply. Message frequency varies.
Consent is not a condition of purchase.</p>
<p>Full details are in our <a href="/a/${escapeHtml(slug)}/privacy-policy">Privacy Policy</a> and
<a href="/a/${escapeHtml(slug)}/terms">Terms of Service</a>.</p>
</div>

${legal && legal !== agency ? `<p>Legal entity: ${escapeHtml(legal)}.</p>` : ""}`;

  return documentShell({
    title: `${agency} — Privacy Policy & Terms`,
    description: `Privacy policy, terms of service, and text messaging disclosures for ${agency}, a licensed life insurance agency.`,
    bodyHtml: body,
    agencyName: agency,
    canonical: `${o.baseUrl}/a/${slug}`,
  });
}

export function renderPrivacyPolicyPage(o: RenderOptions): string {
  const p = o.profile;
  const slug = p.compliance_slug || "";
  const pfx = o.pathPrefix || "";
  const agency = agencyDisplayName(p);
  const entity = entityClause(p);
  const updated = formatLongDate(o.lastUpdatedIso ?? p.compliance_page_published_at);
  const vendors = joinVendorNames(resolveVendorNames(p.lead_vendors));
  const st = stateName(p.business_state);

  const body = `<header class="masthead">
<h1>Privacy Policy</h1>
<p class="tagline">${escapeHtml(agency)}</p>
</header>

<p class="updated">Last updated ${escapeHtml(updated)}</p>

${docNav(slug, "privacy", pfx)}

<h2 id="who-we-are">Who we are</h2>
<p>${escapeHtml(agency)} is a licensed life insurance agency${entity ? `, ${escapeHtml(entity)},` : ""}
that helps individuals and families obtain life insurance coverage. This policy explains what personal
information we collect, how we use it, who we share it with, and the choices you have. It applies to
information we collect by phone, by text message, by email, and through the lead forms described below.</p>
${contactBlock(p)}

<h2 id="where-information-comes-from">Where your information comes from</h2>
<p>We receive your contact information when you request life insurance information through a web form
operated by one of our licensed lead partners (${escapeHtml(vendors)}). Those forms capture your consent
to be contacted by phone and email by licensed insurance agents, including ${escapeHtml(agency)}.
Consent is certified by TrustedForm, which records your IP address, session activity, timestamp, and the
exact disclosure shown to you. We retain that certificate for each person we contact.</p>
<p><strong>Text messages are separate.</strong> We do not text you on the strength of that lead form. To
receive text messages from us you have to opt in yourself, on
<a href="${pfx}/a/${escapeHtml(slug)}/sms-opt-in">our own sign-up page</a>, where the full agreement is
shown to you before you agree to it. We keep a record of exactly what that page said, when you agreed,
and from what IP address.</p>
<p>We also collect information you give us directly — during a phone call, by text or email, or on an
insurance application — including your name, date of birth, address, phone number, email address, and
the health and financial information an insurance carrier requires to underwrite a policy.</p>

<h2 id="text-messaging">Text messaging</h2>
${smsProgramSection(agency)}

<h2 id="mobile-information">Mobile information and text messaging consent</h2>
<div class="verbatim">
<p>${escapeHtml(MOBILE_INFO_PARAGRAPH)}</p>
</div>

<h2 id="how-we-use">How we use your information</h2>
<ul>
<li>Preparing life insurance quotes and comparing coverage options for you</li>
<li>Submitting and following up on insurance applications with carriers</li>
<li>Servicing policies already in force — beneficiary changes, billing questions, claims support</li>
<li>Scheduling and confirming appointments</li>
<li>Responding to your questions and requests</li>
<li>Recordkeeping required by insurance regulators and applicable law</li>
</ul>

<h2 id="who-we-share-with">Who we share your information with</h2>
<ul>
<li><strong>Insurance carriers and their underwriters</strong>, when you ask us to obtain a quote or
submit an application on your behalf.</li>
<li><strong>Service providers under contract with us</strong> — for example our agency management
software, e-signature, telephone, and messaging delivery providers — who may process your information
only to perform services for us.</li>
<li><strong>Regulators, law enforcement, or other parties</strong> where required by law, subpoena, or
to protect our legal rights.</li>
</ul>
<p>We do not sell your personal information. We never share your mobile phone number or your text
messaging consent with third parties for their own marketing purposes.</p>

<h2 id="security-retention">Security and retention</h2>
<p>We restrict access to your information to people who need it to serve you, and we use administrative,
technical, and physical safeguards designed to protect it. We keep your information for as long as we
service your policy and afterward for the period insurance recordkeeping rules require. No method of
storage or transmission is completely secure, and we cannot guarantee absolute security.</p>

<h2 id="your-rights">Your choices and rights</h2>
<ul>
<li><strong>Access and correction</strong> — request a copy of the information we hold about you, or ask
us to correct it.</li>
<li><strong>Deletion</strong> — ask us to delete your information, subject to records we are required to
retain by law.</li>
<li><strong>Do not contact</strong> — ask us to stop calling, texting, or emailing you. Reply STOP to any
text message, or contact us using the details below.</li>
</ul>
<p>To exercise any of these, contact us at the phone number or email address in this policy. We do not
charge for these requests.</p>

<h2 id="children">Children's privacy</h2>
<p>Our services are intended for adults. We do not knowingly collect personal information from anyone
under 18 years of age. If you believe a minor has provided us information, contact us and we will delete
it.</p>

<h2 id="changes">Changes to this policy</h2>
<p>If we change this policy, we will update the "Last updated" date at the top of this page. Continued
communication with us after a change means you accept the updated policy.</p>

<h2 id="contact">Contact us</h2>
<p>Questions about this policy, your information, or your messaging preferences:</p>
${contactBlock(p)}
${st ? `<p>${escapeHtml(agency)} operates from ${escapeHtml(cityStateZip(p))}.</p>` : ""}`;

  return documentShell({
    title: `Privacy Policy — ${agency}`,
    description: `How ${agency}, a licensed life insurance agency, collects, uses, and protects your personal and mobile information, including text messaging consent.`,
    bodyHtml: body,
    agencyName: agency,
    canonical: `${o.baseUrl}/a/${slug}/privacy-policy`,
  });
}

export function renderTermsPage(o: RenderOptions): string {
  const p = o.profile;
  const slug = p.compliance_slug || "";
  const pfx = o.pathPrefix || "";
  const agency = agencyDisplayName(p);
  const entity = entityClause(p);
  const updated = formatLongDate(o.lastUpdatedIso ?? p.compliance_page_published_at);
  // Governing law follows the agent's own state — never a hardcoded default.
  const governing = stateName(p.business_state) || stateName(p.formation_state);

  const body = `<header class="masthead">
<h1>Terms of Service</h1>
<p class="tagline">${escapeHtml(agency)}</p>
</header>

<p class="updated">Last updated ${escapeHtml(updated)}</p>

${docNav(slug, "terms", pfx)}

<p>These terms govern your communications and dealings with ${escapeHtml(agency)}${
    entity ? `, ${escapeHtml(entity)}` : ""
  } ("we", "us", "our"). By contacting us, requesting a quote, or continuing to communicate with us, you
agree to these terms.</p>

<h2 id="not-a-carrier">We are an agency, not an insurance carrier</h2>
<p>${escapeHtml(agency)} is a licensed insurance agency. We are not an insurance company and we do not
underwrite, issue, or pay claims on any policy. Coverage is issued solely by the insurance carrier, and
only that carrier decides whether to approve an application and on what terms.</p>
<p><strong>We cannot guarantee coverage, approval, premium, or rate.</strong> Any quote, illustration, or
premium estimate we provide is an estimate based on the information available at the time and is subject
to underwriting review, which may include medical records, prescription history, motor vehicle records,
and other reports. Your final premium may differ from any estimate, and an application may be declined.
No coverage exists until the carrier issues a policy and any required initial premium is paid.</p>

<h2 id="not-advice">Not financial, tax, or legal advice</h2>
<p>Information we provide is for general educational purposes about insurance products. It is not
financial, investment, tax, or legal advice, and it is not a recommendation tailored to your complete
financial situation. Consult a qualified financial advisor, tax professional, or attorney before making
decisions that depend on those matters.</p>

<h2 id="sms-program">Text messaging program</h2>
${smsProgramSection(agency)}
<div class="verbatim">
<p>${escapeHtml(MOBILE_INFO_PARAGRAPH)}</p>
</div>
<p>See our <a href="/a/${escapeHtml(slug)}/privacy-policy">Privacy Policy</a> for full detail on how we
handle mobile information and messaging consent.</p>

<h2 id="recorded-calls">Recorded calls</h2>
<p>Telephone calls with ${escapeHtml(agency)} may be monitored or recorded for quality assurance,
training, and compliance recordkeeping. Where the law requires notice or consent, we will tell you at the
start of the call. If you do not wish to be recorded, tell us and we will end the recording or continue
the conversation in writing.</p>

<h2 id="accuracy">Accuracy of information you provide</h2>
<p>You agree that the information you give us — including your identity, contact details, health history,
and financial information — is true, accurate, and complete, and that the phone number you provide is
one you own or are authorized to use. Insurance applications are legal documents: inaccurate or omitted
information can cause an application to be declined, a policy to be rescinded, or a claim to be denied.
Tell us promptly if your contact information changes.</p>

<h2 id="disclaimer">Disclaimer and limitation of liability</h2>
<p>Our services and this website are provided "as is" and "as available", without warranties of any kind,
express or implied, including any implied warranties of merchantability, fitness for a particular
purpose, or non-infringement. We do not warrant that this page will be uninterrupted or error-free.</p>
<p>To the fullest extent permitted by law, ${escapeHtml(agency)} is not liable for any indirect,
incidental, special, consequential, or punitive damages, or for lost profits or lost data, arising out of
your use of this page or our services. Nothing in these terms limits liability that cannot be limited
under applicable law, and nothing here affects your rights against an insurance carrier under a policy it
has issued to you.</p>

<h2 id="governing-law">Governing law</h2>
<p>These terms are governed by the laws of ${
    governing ? `the State of ${escapeHtml(governing)}` : "the state in which our agency is located"
  }, without regard to its conflict of laws rules. Any dispute arising from these terms or our services
will be brought in the state or federal courts located in ${
    governing ? `the State of ${escapeHtml(governing)}` : "that state"
  }. Insurance policies themselves are governed by their own terms and by the insurance laws of the state
in which the policy is issued.</p>

<h2 id="changes">Changes to these terms</h2>
<p>We may update these terms. The "Last updated" date at the top of this page reflects the current
version. Continuing to communicate with us after a change means you accept the updated terms.</p>

<h2 id="contact">Contact us</h2>
${contactBlock(p)}`;

  return documentShell({
    title: `Terms of Service — ${agency}`,
    description: `Terms of service, text messaging program terms, and disclosures for ${agency}, a licensed life insurance agency.`,
    bodyHtml: body,
    agencyName: agency,
    canonical: `${o.baseUrl}/a/${slug}/terms`,
  });
}

// ============================================================
// SMS opt-in page (/a/:slug/sms-opt-in)
//
// WHY THIS PAGE EXISTS: the 10DLC campaign was rejected because carrier
// review would not accept the lead vendor's "…and its licensed agents"
// wording as opt-in evidence for a campaign sending as the agency. The
// vendor will not change their form, so we stop leaning on their consent and
// collect our own, on a page branded to the business that actually sends.
//
// THE DISCLOSURE IS ONE STRING. buildOptInDisclosure() returns the exact
// sentence set the consumer reads, and it is used for BOTH the rendered page
// and the consent_records.disclosure_text we store. There is deliberately no
// second copy to drift: "what were they agreeing to?" is answered by a string
// that provably came from the same function call that drew the page. The HTML
// version escapes that string and turns the two URLs inside it into links —
// it never rewords it.
//
// THE CHECKBOX IS NEVER PRE-CHECKED. Not on first render, and NOT on an
// error re-render either, even when the consumer had ticked it and got the
// phone number wrong. A box we tick for them is not consent, and re-ticking
// it "helpfully" after a validation bounce is exactly the pattern carrier
// review rejects. They tick it, every time.
// ============================================================

/** Values a consumer typed, preserved across a validation bounce (no JS to hold them). */
export interface OptInFormValues {
  first_name?: string;
  last_name?: string;
  phone?: string;
}

export interface OptInRenderOptions extends RenderOptions {
  /** Plain-English problem to show above the form. Null on first render. */
  error?: string | null;
  /** What they typed last time, so a bounce does not make them start over. */
  values?: OptInFormValues | null;
}

/**
 * Escape the disclosure for HTML, then linkify the two URLs it contains.
 *
 * Safe because escapeHtml() cannot alter a URL built from our own base URL
 * and an `isValidSlug()` slug — it contains no &, <, >, quote or apostrophe —
 * so the escaped string still contains the URL byte-for-byte and the
 * replacement lands on the same text the consumer reads. The text is the
 * source of truth; this only decorates it.
 */
function disclosureHtml(text: string, urls: { privacy: string; terms: string }): string {
  let html = escapeHtml(text);
  for (const url of [urls.privacy, urls.terms]) {
    html = html.split(url).join(
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`,
    );
  }
  return html;
}

export function renderSmsOptInPage(o: OptInRenderOptions): string {
  const p = o.profile;
  const slug = p.compliance_slug || "";
  const pfx = o.pathPrefix || "";
  const agency = agencyDisplayName(p);
  const urls = compliancePageUrls(o.baseUrl, slug);
  const disclosure = buildOptInDisclosure(agency, urls);
  const v = o.values || {};
  const action = `${pfx}/a/${escapeHtml(slug)}/sms-opt-in`;

  const body = `<header class="masthead">
<h1>Text message sign-up</h1>
<p class="tagline">${escapeHtml(agency)}</p>
</header>

${docNav(slug, "sms-opt-in", pfx)}

<p>Sign up to get text messages from ${escapeHtml(agency)} about your life insurance quote, your
appointments, and the status of your application. Fill in your details, read the agreement, and tick the
box — we will text you once to confirm.</p>

${
    o.error
      ? `<div class="errbox" role="alert"><p>${escapeHtml(o.error)}</p></div>`
      : ""
  }
<form method="post" action="${action}">
<div class="field">
<label for="first_name">First name</label>
<input type="text" id="first_name" name="first_name" autocomplete="given-name" maxlength="60" required
 value="${escapeHtml(v.first_name || "")}">
</div>

<div class="field">
<label for="last_name">Last name</label>
<input type="text" id="last_name" name="last_name" autocomplete="family-name" maxlength="60" required
 value="${escapeHtml(v.last_name || "")}">
</div>

<div class="field">
<label for="phone">Mobile number</label>
<input type="tel" id="phone" name="phone" autocomplete="tel" maxlength="24" required
 value="${escapeHtml(v.phone || "")}">
<p class="hint">A US mobile number, so we can text you. Example: (555) 123-4567</p>
</div>

<div class="hp" aria-hidden="true"><label for="company_website">Leave this field empty</label>
<input type="text" id="company_website" name="company_website" tabindex="-1" autocomplete="off"></div>

<div class="consent">
<input type="checkbox" id="consent" name="consent" value="yes">
<label for="consent" class="disclosure" style="font-weight:400;font-size:14px">${
    disclosureHtml(disclosure, urls)
  }</label>
</div>

<button type="submit" class="submit">Agree and sign up</button>
</form>

<h2>What happens next</h2>
<ul>
<li>We text the number you gave us once, to confirm you are signed up.</li>
<li>After that you will hear from us about your quote, your appointments, and your application — nothing else.</li>
<li>Reply <strong>STOP</strong> to any message and we stop texting you. Reply <strong>HELP</strong> and we
will tell you how to reach a person.</li>
<li>You are never required to agree to texts in order to buy insurance from us.</li>
</ul>

<h2>Questions</h2>
${contactBlock(p)}`;

  return documentShell({
    title: `Text message sign-up — ${agency}`,
    description: `Sign up to receive text messages from ${agency} about your life insurance quote, appointments, and application status.`,
    bodyHtml: body,
    agencyName: agency,
    canonical: `${o.baseUrl}/a/${slug}/sms-opt-in`,
  });
}

/**
 * Plain confirmation, shown after a successful POST (via a redirect, so a
 * refresh cannot resubmit).
 *
 * `stopWarning` is set when the number is on the do-not-contact list. We
 * still record the consent — they asked for it and that is evidence — but we
 * do NOT text them, because a web form is unverified and a STOP came from the
 * handset itself. Telling them plainly to text START is the only honest thing
 * to put on the page; silently doing nothing would read as success.
 */
export function renderSmsOptInConfirmedPage(
  o: RenderOptions & { firstName?: string | null; maskedPhone?: string | null; stopWarning?: boolean },
): string {
  const p = o.profile;
  const slug = p.compliance_slug || "";
  const pfx = o.pathPrefix || "";
  const agency = agencyDisplayName(p);
  const name = (o.firstName || "").trim();

  const body = `<header class="masthead">
<h1>You're signed up</h1>
<p class="tagline">${escapeHtml(agency)}</p>
</header>

${docNav(slug, "sms-opt-in", pfx)}

<div class="card">
<h2>${name ? `Thanks, ${escapeHtml(name)}.` : "Thanks."}</h2>
${
    o.stopWarning
      ? `<p>We have recorded your agreement to receive text messages from ${escapeHtml(agency)}${
        o.maskedPhone ? ` at ${escapeHtml(o.maskedPhone)}` : ""
      }.</p>
<p><strong>One more step.</strong> That number previously replied STOP to us, so your phone carrier is
still blocking our messages — and we cannot lift that from our end, by design. Text the word
<strong>START</strong> to the number you last heard from us on, and messages will resume.</p>`
      : `<p>We have recorded your agreement to receive text messages from ${escapeHtml(agency)}${
        o.maskedPhone ? ` at ${escapeHtml(o.maskedPhone)}` : ""
      }. A confirmation text is on its way now.</p>`
  }
</div>

<h2>What you agreed to</h2>
<ul>
<li>Messages about your insurance quote, your appointments, and your application status.</li>
<li>Message frequency varies. Message and data rates may apply.</li>
<li>Agreeing to texts is not a condition of buying anything.</li>
<li>Reply <strong>STOP</strong> to any message to stop them, or <strong>HELP</strong> for help.</li>
</ul>
<p>The full detail is in our <a href="${pfx}/a/${escapeHtml(slug)}/privacy-policy">Privacy Policy</a> and
<a href="${pfx}/a/${escapeHtml(slug)}/terms">Terms of Service</a>.</p>

<h2>Reach us</h2>
${contactBlock(p)}`;

  return documentShell({
    title: `You're signed up — ${agency}`,
    description: `Text message sign-up confirmation for ${agency}.`,
    bodyHtml: body,
    agencyName: agency,
    canonical: `${o.baseUrl}/a/${slug}/sms-opt-in/confirmed`,
  });
}

/**
 * 404 body for an unknown or unpublished slug. Plain, self-contained, and
 * deliberately NOT a stack trace or a redirect to our marketing site — a
 * reviewer who mistypes a URL should see a clean page, not our funnel.
 */
export function renderNotFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Page not found</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="masthead">
<h1>Page not found</h1>
<p class="tagline">This address does not match a published agency page.</p>
</header>
<p>The link you followed may be mistyped or out of date. If you received a text message and are looking
for the sender's privacy policy, reply <strong>HELP</strong> to that message and the agency will respond
with their contact information. Reply <strong>STOP</strong> to any message to opt out.</p>
</div>
</body>
</html>`;
}

/**
 * Public origin the compliance pages are served from.
 *
 * producerstackcrm.com itself is GitHub Pages (static only — verified
 * 2026-07-27: `Server: GitHub.com`), so it cannot render per-agent pages.
 * The `trust.` subdomain is a thin Vercel project that rewrites /a/* to this
 * function — see vercel-trust/README.md. Override per-environment with the
 * COMPLIANCE_PAGE_BASE_URL secret; every caller reads that first and falls
 * back here, so the value can only be wrong in one place.
 */
export const DEFAULT_COMPLIANCE_BASE_URL = "https://trust.producerstackcrm.com";

/** Canonical public URLs for an agent's pages. Single source for the A2P submitter and the UI. */
export function compliancePageUrls(baseUrl: string, slug: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    index: `${base}/a/${slug}`,
    privacy: `${base}/a/${slug}/privacy-policy`,
    terms: `${base}/a/${slug}/terms`,
    smsOptIn: `${base}/a/${slug}/sms-opt-in`,
  };
}

/**
 * "0123" -> "(•••) •••-0123".
 *
 * The confirmation page only ever receives the last four digits — the full
 * number is deliberately never put in a URL, because that URL ends up in
 * browser history and in any referrer a linked page sees. Four digits is
 * enough for a consumer to recognise their own number and not enough to be
 * anyone's number.
 */
export function maskPhoneLast4(last4: string | null | undefined): string {
  const d = String(last4 || "").replace(/\D/g, "");
  return d.length === 4 ? `(•••) •••-${d}` : "";
}

/** "+15555550123" -> "(•••) •••-0123". Same mask, from a whole number. */
export function maskPhoneDisplay(phone: string | null | undefined): string {
  const digits = String(phone || "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return "";
  return maskPhoneLast4(local.slice(6));
}
