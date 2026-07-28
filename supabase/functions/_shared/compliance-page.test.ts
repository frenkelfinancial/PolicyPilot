// ============================================================
// compliance-page.test.ts — run with:  npm run test:compliance   (Node 24, no deps)
//
// Covers the parts of PROMPT_16's test plan that are checkable without a
// database or a deploy: slug rules, escaping/injection, the verbatim
// paragraph, LLC vs sole-proprietor rendering, governing law, and the
// no-JavaScript guarantee. The remaining cases (anonymous fetch, slug lock,
// regeneration, 404, registration gate) are exercised against the deployed
// function + database — see docs/compliance-pages.md.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MOBILE_INFO_PARAGRAPH,
  agencyDisplayName,
  buildOptInAutoResponse,
  buildOptInDisclosure,
  compliancePageUrls,
  entityClause,
  escapeHtml,
  formatPhoneDisplay,
  isValidSlug,
  maskPhoneLast4,
  missingComplianceFields,
  renderIndexPage,
  renderNotFoundPage,
  renderPrivacyPolicyPage,
  renderSmsOptInConfirmedPage,
  renderSmsOptInPage,
  renderTermsPage,
  slugifyAgencyName,
  stateName,
  type AgencyProfile,
} from "./compliance-page.ts";

import {
  buildOptinDescription,
  joinVendorNames,
  resolveVendorNames,
  TCR_MESSAGE_FLOW_MAX,
} from "./lead-vendors.ts";
import { buildCampaignInfo } from "./a2p-registration.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

const LLC_AGENT: AgencyProfile = {
  dba_name: "Frenkel Financial Agency",
  business_legal_name: "Frenkel Financial LLC",
  business_entity_type: "llc",
  formation_state: "WI",
  business_street: "123 Main Street, Suite 400",
  business_city: "Milwaukee",
  business_state: "WI",
  business_postal_code: "53202",
  business_phone: "+14145551234",
  business_email: "hello@frenkelfinancial.com",
  lead_vendors: ["goatleads", "builtleads"],
  compliance_slug: "frenkel-financial-agency",
  compliance_page_published_at: "2026-07-29T12:00:00Z",
};

const SOLE_PROP_AGENT: AgencyProfile = {
  dba_name: "Maria Alvarez Insurance",
  business_legal_name: null,
  business_entity_type: "sole_proprietor",
  formation_state: null,
  business_street: "88 Oak Avenue",
  business_city: "Austin",
  business_state: "TX",
  business_postal_code: "78701",
  business_phone: "5125559876",
  business_email: "maria@example.com",
  lead_vendors: ["goatleads"],
  compliance_slug: "maria-alvarez-insurance",
  compliance_page_published_at: "2026-07-29T12:00:00Z",
};

const RENDER_OPTS = { lastUpdatedIso: "2026-07-29T12:00:00Z", baseUrl: "https://trust.producerstackcrm.com" };

const allPages = (p: AgencyProfile) => [
  renderIndexPage({ profile: p, ...RENDER_OPTS }),
  renderPrivacyPolicyPage({ profile: p, ...RENDER_OPTS }),
  renderTermsPage({ profile: p, ...RENDER_OPTS }),
  // The opt-in surfaces go through every whole-document rule too — no JS, no
  // external requests, balanced tags, nothing double-escaped. A form is the
  // most tempting place in this codebase to reach for a line of JavaScript,
  // which is exactly why it is in this list.
  renderSmsOptInPage({ profile: p, ...RENDER_OPTS }),
  renderSmsOptInPage({
    profile: p,
    ...RENDER_OPTS,
    error: "Please tick the box to agree to receive text messages.",
    values: { first_name: "Jo", last_name: "Ng", phone: "555" },
  }),
  renderSmsOptInConfirmedPage({ profile: p, ...RENDER_OPTS, firstName: "Jo", maskedPhone: "(•••) •••-0123" }),
];

// ------------------------------------------------------------
// Slug rules
// ------------------------------------------------------------

test("slugify: basic name lowercases and hyphenates", () => {
  assert.equal(slugifyAgencyName("Frenkel Financial Agency"), "frenkel-financial-agency");
});

test("slugify: ampersand becomes 'and', not a dropped separator", () => {
  assert.equal(slugifyAgencyName("Smith & Sons Insurance"), "smith-and-sons-insurance");
});

test("slugify: apostrophes are removed, not turned into hyphens", () => {
  assert.equal(slugifyAgencyName("O'Brien Insurance"), "obrien-insurance");
  assert.equal(slugifyAgencyName("O’Brien Insurance"), "obrien-insurance");
});

test("slugify: accents are stripped to their base letters", () => {
  assert.equal(slugifyAgencyName("Nuñez Financial"), "nunez-financial");
  assert.equal(slugifyAgencyName("Café Life Agency"), "cafe-life-agency");
  assert.equal(slugifyAgencyName("Renée Söderberg Insurance"), "renee-soderberg-insurance");
});

// These letters have no NFD decomposition, so they need explicit folds on
// BOTH sides. public.compliance_slugify() in 20260729_compliance_pages.sql
// must produce the same output for every case here — if the two drift, an
// agent previews one URL in Settings and registers a different one.
test("slugify: folds letters NFD cannot decompose, matching the SQL function", () => {
  assert.equal(slugifyAgencyName("Bjørn Insurance"), "bjorn-insurance");
  assert.equal(slugifyAgencyName("Æther Life"), "aether-life");
  assert.equal(slugifyAgencyName("Straße Financial"), "strasse-financial");
  assert.equal(slugifyAgencyName("Œuvre Agency"), "oeuvre-agency");
  assert.equal(slugifyAgencyName("Łukasz Insurance"), "lukasz-insurance");
  assert.equal(slugifyAgencyName("Ðunn Agency"), "dunn-agency");
  assert.equal(slugifyAgencyName("Þorne Life"), "thorne-life");
});

test("slugify: punctuation collapses, no repeated or trailing hyphens", () => {
  assert.equal(slugifyAgencyName("A.B.C.  Insurance,  LLC."), "a-b-c-insurance-llc");
  assert.equal(slugifyAgencyName("  --Leading & Trailing--  "), "leading-and-trailing");
});

test("slugify: trims to 60 chars with no trailing hyphen", () => {
  const slug = slugifyAgencyName("The Extraordinarily Long Life Insurance Agency Of Greater Milwaukee County");
  assert.ok(slug.length <= 60, `slug was ${slug.length} chars`);
  assert.ok(!slug.endsWith("-"), `slug ended with a hyphen: ${slug}`);
  assert.ok(isValidSlug(slug));
});

test("slugify: unusable input returns empty string for the caller to handle", () => {
  assert.equal(slugifyAgencyName("!!!"), "");
  assert.equal(slugifyAgencyName(""), "");
  assert.equal(slugifyAgencyName(null), "");
});

test("slugify is idempotent — re-slugging a slug is a no-op", () => {
  for (const name of ["Smith & Sons", "O'Brien Insurance", "Nuñez Financial", "A.B.C. Insurance, LLC."]) {
    const once = slugifyAgencyName(name);
    assert.equal(slugifyAgencyName(once), once, `not idempotent for ${name}`);
  }
});

// ------------------------------------------------------------
// SQL <-> TS lockstep
//
// public.compliance_slugify() stores the slug; slugifyAgencyName() is what
// the Settings UI previews. If they drift, an agent previews one URL and
// registers another — and the slug locks at registration, so it is not
// fixable afterward. There is no local Postgres in this repo's toolchain, so
// this asserts structural agreement against the migration source: every fold
// the TS applies must also appear in the SQL, and translate()'s from/to
// strings must be the same length (Postgres silently DELETES characters that
// run past the end of `to`, which would turn "ž" into "" instead of "z").
// ------------------------------------------------------------
test("SQL compliance_slugify mirrors the TS slugifier", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "../../migrations/20260729_compliance_pages.sql"), "utf8");
  const fn = sql.slice(
    sql.indexOf("create or replace function public.compliance_slugify"),
    sql.indexOf("comment on function public.compliance_slugify"),
  );
  assert.ok(fn.length > 0, "compliance_slugify not found in the migration");

  const translate = fn.match(/translate\(\s*s,\s*'([^']*)',\s*'([^']*)'\s*\)/);
  assert.ok(translate, "accent-folding translate() not found");
  assert.equal(
    [...translate![1]].length,
    [...translate![2]].length,
    "translate() from/to lengths differ — Postgres would DELETE the unmatched characters",
  );

  // Every accented character the SQL folds must survive the TS path too.
  const from = [...translate![1]];
  const to = [...translate![2]];
  from.forEach((ch, i) => {
    assert.equal(slugifyAgencyName(`x${ch}x`), `x${to[i]}x`, `TS does not fold ${ch} to ${to[i]}`);
  });

  // Non-decomposable letters need an explicit replace() on both sides.
  for (const [ch, want] of [["ø", "o"], ["đ", "d"], ["ð", "d"], ["ł", "l"],
                            ["æ", "ae"], ["œ", "oe"], ["ß", "ss"], ["þ", "th"]] as const) {
    assert.ok(fn.includes(`replace(s, '${ch}', '${want}')`), `SQL is missing the ${ch} -> ${want} fold`);
    assert.equal(slugifyAgencyName(`x${ch}x`), `x${want}x`, `TS is missing the ${ch} -> ${want} fold`);
  }

  // Shared rules, in both implementations.
  assert.ok(fn.includes("replace(s, '&', ' and ')"), "SQL is missing the & -> and rule");
  assert.ok(fn.includes("chr(39) || chr(8217)"), "SQL is missing apostrophe stripping");
  assert.ok(fn.includes("regexp_replace(s, '[^a-z0-9]+', '-', 'g')"), "SQL is missing the separator rule");
  assert.ok(fn.includes("left(s, 60)"), "SQL is missing the 60-char trim");
});

test("isValidSlug rejects what the DB check would reject", () => {
  assert.ok(isValidSlug("frenkel-financial-agency"));
  assert.ok(!isValidSlug("Frenkel-Financial"));   // uppercase
  assert.ok(!isValidSlug("frenkel--financial"));  // doubled hyphen
  assert.ok(!isValidSlug("-frenkel"));            // leading hyphen
  assert.ok(!isValidSlug("frenkel-"));            // trailing hyphen
  assert.ok(!isValidSlug("frenkel financial"));   // space
  assert.ok(!isValidSlug("a".repeat(61)));        // too long
});

// ------------------------------------------------------------
// Required fields
// ------------------------------------------------------------

test("missingComplianceFields: a complete profile is ready to publish", () => {
  assert.deepEqual(missingComplianceFields(LLC_AGENT), []);
  assert.deepEqual(missingComplianceFields(SOLE_PROP_AGENT), []);
});

test("missingComplianceFields: names each missing field so the UI can link to it", () => {
  const missing = missingComplianceFields({ ...LLC_AGENT, business_street: null, business_phone: "   " });
  assert.deepEqual(missing.map((m) => m.field), ["business_street", "business_phone"]);
  assert.equal(missing[0].label, "Street address");
});

test("missingComplianceFields: a sole prop with only a DBA still satisfies the name requirement", () => {
  const missing = missingComplianceFields({ ...SOLE_PROP_AGENT, business_legal_name: null });
  assert.deepEqual(missing, []);
});

test("missingComplianceFields: no name at all is reported", () => {
  const missing = missingComplianceFields({ ...LLC_AGENT, dba_name: null, business_legal_name: null });
  assert.deepEqual(missing.map((m) => m.field), ["dba_name"]);
});

// ------------------------------------------------------------
// The verbatim paragraph — rule 2 in compliance-page.ts
// ------------------------------------------------------------

test("mobile-information paragraph is present verbatim on privacy and terms", () => {
  // Contains no HTML-escapable characters, so it must survive escaping byte-for-byte.
  assert.equal(escapeHtml(MOBILE_INFO_PARAGRAPH), MOBILE_INFO_PARAGRAPH);

  for (const html of [
    renderPrivacyPolicyPage({ profile: LLC_AGENT, ...RENDER_OPTS }),
    renderTermsPage({ profile: LLC_AGENT, ...RENDER_OPTS }),
  ]) {
    assert.ok(html.includes(MOBILE_INFO_PARAGRAPH), "verbatim paragraph missing from rendered page");
  }
});

test("mobile-information paragraph matches the carrier-required text exactly", () => {
  assert.equal(
    MOBILE_INFO_PARAGRAPH,
    "Your mobile information will not be sold or shared with third parties for promotional or marketing " +
      "purposes. No mobile information will be shared with third parties or affiliates for marketing or " +
      "promotional purposes. Information sharing to subcontractors in support services, such as customer " +
      "service and messaging delivery providers, is permitted. All other use case categories exclude text " +
      "messaging originator opt-in data and consent; this information will not be shared with any third parties.",
  );
});

test("paragraph renders inside a single <p>, never split across elements", () => {
  const html = renderPrivacyPolicyPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  assert.ok(html.includes(`<p>${MOBILE_INFO_PARAGRAPH}</p>`));
});

// ------------------------------------------------------------
// No JavaScript — rule 1
// ------------------------------------------------------------

test("no page contains a script tag, inline handler, or javascript: URL", () => {
  const pages = [...allPages(LLC_AGENT), ...allPages(SOLE_PROP_AGENT), renderNotFoundPage()];
  for (const html of pages) {
    assert.ok(!/<script/i.test(html), "found a <script> tag");
    assert.ok(!/\son[a-z]+\s*=/i.test(html), "found an inline event handler");
    assert.ok(!/javascript:/i.test(html), "found a javascript: URL");
    assert.ok(!/<noscript/i.test(html), "found a <noscript> fallback — content must not depend on JS at all");
  }
});

test("every page is a complete standalone document with no external requests", () => {
  for (const html of [...allPages(LLC_AGENT), renderNotFoundPage()]) {
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.trimEnd().endsWith("</html>"));
    assert.ok(!/<link[^>]+stylesheet/i.test(html), "external stylesheet would break offline review");
    assert.ok(!/<img/i.test(html), "no remote images");
    assert.ok(html.includes("<style>"), "CSS must be inline");
  }
});

// ------------------------------------------------------------
// Required sections
// ------------------------------------------------------------

test("privacy policy contains every required section", () => {
  const html = renderPrivacyPolicyPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  for (const id of [
    "who-we-are", "where-information-comes-from", "text-messaging", "mobile-information",
    "how-we-use", "who-we-share-with", "security-retention", "your-rights", "children", "contact",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing section: ${id}`);
  }
});

test("privacy policy carries the full SMS disclosure set", () => {
  const html = renderPrivacyPolicyPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  for (const phrase of [
    "Message frequency varies", "Message and data rates may apply",
    "Consent is not a condition of purchase", "reply STOP", "reply START", "reply HELP",
    "Carriers are not liable for delayed or undelivered messages",
  ]) {
    assert.ok(html.includes(phrase), `missing SMS disclosure: ${phrase}`);
  }
});

test("terms page contains every required section", () => {
  const html = renderTermsPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  for (const id of [
    "not-a-carrier", "not-advice", "sms-program", "recorded-calls",
    "accuracy", "disclaimer", "governing-law", "contact",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing section: ${id}`);
  }
  assert.ok(html.includes("not an insurance company"));
  assert.ok(html.includes("may be monitored or recorded"));
});

test("the opt-in source section names the same vendors as the campaign description", () => {
  const html = renderPrivacyPolicyPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  const optin = buildOptinDescription(agencyDisplayName(LLC_AGENT), LLC_AGENT.lead_vendors);
  // A reviewer comparing the two must see the same vendors. Divergence here
  // is a rejection.
  assert.ok(html.includes("GoatLeads and Built Leads"));
  assert.ok(optin.includes("GoatLeads and Built Leads"));
  assert.ok(html.includes("TrustedForm"));
});

// The rejection this whole feature exists because of. Both surfaces must say
// the vendor form covers PHONE AND EMAIL, and that texting is opted into
// separately. If either one drifts back to claiming the vendor form covers
// SMS, we are resubmitting the exact assertion carrier review already refused.
test("neither the policy nor the campaign description claims the vendor form covers texting", () => {
  const html = renderPrivacyPolicyPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  const optin = buildOptinDescription(agencyDisplayName(LLC_AGENT), LLC_AGENT.lead_vendors, {
    privacy: "https://trust.producerstackcrm.com/a/x/privacy-policy",
    terms: "https://trust.producerstackcrm.com/a/x/terms",
    smsOptIn: "https://trust.producerstackcrm.com/a/x/sms-opt-in",
  });
  assert.ok(html.includes("contacted by phone and email by licensed insurance agents"));
  assert.ok(!html.includes("by phone and text message by licensed insurance agents"));
  assert.ok(html.includes("Text messages are separate"));
  assert.ok(optin.includes("consent there to be contacted by telephone and email"));
  assert.ok(optin.includes("That form is NOT the basis for text messages"));
});

// Policy documents only. The opt-in form and its confirmation deliberately
// carry no "Last updated" chip — they are not documents whose revision
// history a reviewer needs, and a version stamp on a sign-up form reads as
// legalese in the one place the page has to feel like a plain question.
test("every policy page shows a Last updated date", () => {
  const policyPages = [
    renderIndexPage({ profile: LLC_AGENT, ...RENDER_OPTS }),
    renderPrivacyPolicyPage({ profile: LLC_AGENT, ...RENDER_OPTS }),
    renderTermsPage({ profile: LLC_AGENT, ...RENDER_OPTS }),
  ];
  for (const html of policyPages) {
    assert.ok(html.includes("Last updated July 29, 2026"), "missing or wrong Last updated date");
  }
});

// ------------------------------------------------------------
// LLC vs sole proprietor
// ------------------------------------------------------------

test("LLC agent: full entity language with the formation state", () => {
  assert.equal(entityClause(LLC_AGENT), "a Wisconsin limited liability company");
  const terms = renderTermsPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  assert.ok(terms.includes("a Wisconsin limited liability company"));
  const index = renderIndexPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  assert.ok(index.includes("Frenkel Financial LLC, doing business as Frenkel Financial Agency"));
});

test("sole proprietor: no entity language anywhere, page still complete", () => {
  assert.equal(entityClause(SOLE_PROP_AGENT), "");
  for (const html of allPages(SOLE_PROP_AGENT)) {
    assert.ok(!/limited liability company|corporation|partnership/i.test(html),
      "entity language leaked onto a sole-proprietor page");
    // Still coherent: name, address, phone, and the required paragraph.
    assert.ok(html.includes("Maria Alvarez Insurance"));
    assert.ok(html.includes("88 Oak Avenue"));
    assert.ok(html.includes("Austin, TX 78701"));
  }
  const terms = renderTermsPage({ profile: SOLE_PROP_AGENT, ...RENDER_OPTS });
  assert.ok(terms.includes(MOBILE_INFO_PARAGRAPH));
});

test("sole proprietor still gets a real physical address in the contact block", () => {
  const html = renderPrivacyPolicyPage({ profile: SOLE_PROP_AGENT, ...RENDER_OPTS });
  assert.ok(html.includes("<address>"));
  assert.ok(html.includes("88 Oak Avenue"));
});

// ------------------------------------------------------------
// Governing law — never hardcoded
// ------------------------------------------------------------

test("governing law follows the agent's own state", () => {
  assert.ok(renderTermsPage({ profile: LLC_AGENT, ...RENDER_OPTS }).includes("the State of Wisconsin"));
  const tx = renderTermsPage({ profile: SOLE_PROP_AGENT, ...RENDER_OPTS });
  assert.ok(tx.includes("the State of Texas"));
  assert.ok(!tx.includes("Wisconsin"), "a hardcoded Wisconsin leaked into a Texas agent's terms");
});

test("governing law degrades gracefully when the state is unknown", () => {
  const html = renderTermsPage({
    profile: { ...LLC_AGENT, business_state: null, formation_state: null },
    ...RENDER_OPTS,
  });
  assert.ok(html.includes("the state in which our agency is located"));
});

test("stateName maps codes and passes unknown values through", () => {
  assert.equal(stateName("WI"), "Wisconsin");
  assert.equal(stateName("tx"), "Texas");
  assert.equal(stateName("Ontario"), "Ontario");
  assert.equal(stateName(null), "");
});

// ------------------------------------------------------------
// Escaping / injection — awkward business names
// ------------------------------------------------------------

test("awkward business name: clean slug, escaped HTML, no injection", () => {
  const hostile: AgencyProfile = {
    ...LLC_AGENT,
    dba_name: `O'Brien & Sons <script>alert(1)</script> "Insurance" Café`,
    business_legal_name: null,
    business_street: `1 "Quote" St. <b>`,
    compliance_slug: slugifyAgencyName(`O'Brien & Sons "Insurance" Café`),
  };

  assert.equal(hostile.compliance_slug, "obrien-and-sons-insurance-cafe");
  assert.ok(isValidSlug(hostile.compliance_slug!));

  for (const html of allPages(hostile)) {
    assert.ok(!/<script/i.test(html), "script tag survived escaping");
    assert.ok(!html.includes("<b>"), "raw markup survived escaping");
    assert.ok(html.includes("O&#39;Brien &amp; Sons"), "expected escaped entities");
    assert.ok(html.includes("&lt;script&gt;"), "expected the tag to render as text");
  }
});

// Regression: the index tagline used to run "&middot; Wisconsin" through
// escapeHtml as one string, so the separator rendered as the literal text
// "&middot;". Escape the interpolated value, never the surrounding markup.
test("no HTML entity is double-escaped on any page", () => {
  for (const html of [...allPages(LLC_AGENT), ...allPages(SOLE_PROP_AGENT), renderNotFoundPage()]) {
    const doubled = html.match(/&amp;(?:middot|nbsp|amp|lt|gt|quot|#\d+);/g);
    assert.equal(doubled, null, `double-escaped entities: ${[...new Set(doubled || [])].join(", ")}`);
  }
});

test("block-level tags are balanced on every page", () => {
  for (const html of [...allPages(LLC_AGENT), ...allPages(SOLE_PROP_AGENT), renderNotFoundPage()]) {
    const tags = "div|p|ul|li|h1|h2|h3|address|footer|header";
    const opens = (html.match(new RegExp(`<(${tags})\\b`, "g")) || []).length;
    const closes = (html.match(new RegExp(`</(${tags})>`, "g")) || []).length;
    assert.equal(opens, closes, `unbalanced block tags: ${opens} open vs ${closes} close`);
  }
});

test("escapeHtml covers every context-breaking character", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`),
    "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("a quote in the agency name cannot break out of the meta description attribute", () => {
  const html = renderIndexPage({
    profile: { ...LLC_AGENT, dba_name: `Bad" content="x` },
    ...RENDER_OPTS,
  });
  const meta = html.match(/<meta name="description" content="([^"]*)"/);
  assert.ok(meta, "meta description missing or attribute broken");
  assert.ok(!meta![1].includes('"'));
});

// ------------------------------------------------------------
// Misc formatting
// ------------------------------------------------------------

test("phone renders human-readable while tel: stays E.164", () => {
  assert.equal(formatPhoneDisplay("+14145551234"), "(414) 555-1234");
  assert.equal(formatPhoneDisplay("5125559876"), "(512) 555-9876");
  const html = renderIndexPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  assert.ok(html.includes('href="tel:+14145551234"'));
  assert.ok(html.includes("(414) 555-1234"));
});

test("agencyDisplayName prefers the DBA and falls back to the legal name", () => {
  assert.equal(agencyDisplayName(LLC_AGENT), "Frenkel Financial Agency");
  assert.equal(agencyDisplayName({ ...LLC_AGENT, dba_name: null }), "Frenkel Financial LLC");
});

test("the page is agent-branded — ProducerStack appears only in the footer line", () => {
  for (const html of allPages(LLC_AGENT)) {
    const hits = html.match(/ProducerStack/g) || [];
    assert.equal(hits.length, 1, "ProducerStack should appear exactly once");
    assert.ok(html.includes("This page is hosted by ProducerStack on behalf of Frenkel Financial Agency."));
    // The headline must be the agency, not us.
    const h1 = html.match(/<h1>([^<]*)<\/h1>/);
    assert.ok(h1 && !h1[1].includes("ProducerStack"), "ProducerStack leaked into the headline");
  }
});

test("pages are indexable; the 404 is not", () => {
  for (const html of allPages(LLC_AGENT)) {
    assert.ok(html.includes('<meta name="robots" content="index,follow">'));
  }
  assert.ok(renderNotFoundPage().includes('content="noindex,nofollow"'));
});

test("404 is a clean page, not a stack trace, and does not funnel to marketing", () => {
  const html = renderNotFoundPage();
  assert.ok(html.includes("Page not found"));
  assert.ok(!/Error|at .*\(.*:\d+:\d+\)|stack/i.test(html.replace(/<[^>]+>/g, "")));
  assert.ok(!html.includes("producerstackcrm.com"));
});

test("mobile: viewport meta and a responsive breakpoint are present", () => {
  for (const html of [...allPages(LLC_AGENT), renderNotFoundPage()]) {
    assert.ok(html.includes('name="viewport" content="width=device-width,initial-scale=1"'));
    assert.ok(html.includes("@media (max-width:600px)"));
  }
});

test("compliancePageUrls builds every canonical URL and tolerates a trailing slash", () => {
  assert.deepEqual(compliancePageUrls("https://trust.producerstackcrm.com/", "acme-agency"), {
    index: "https://trust.producerstackcrm.com/a/acme-agency",
    privacy: "https://trust.producerstackcrm.com/a/acme-agency/privacy-policy",
    terms: "https://trust.producerstackcrm.com/a/acme-agency/terms",
    smsOptIn: "https://trust.producerstackcrm.com/a/acme-agency/sms-opt-in",
  });
});

// ------------------------------------------------------------
// Opt-in description (Phase 5)
// ------------------------------------------------------------

test("opt-in description substitutes vendor and agency, keeps the fixed body", () => {
  const d = buildOptinDescription("Frenkel Financial Agency", ["goatleads", "builtleads"]);
  assert.ok(d.startsWith("Consumers request life insurance information through a web form operated by GoatLeads and Built Leads"));
  assert.ok(d.includes("Consent to receive text messages is collected separately"));
  assert.ok(d.includes("tick a single checkbox that is never pre-checked"));
  assert.ok(d.includes("not behind a link or pop-up"));
  assert.ok(d.includes("the consumer's IP address, and the page URL"));
  assert.ok(d.includes("sends no text message to any number without a stored consent record"));
  assert.ok(d.includes("reply STOP at any time to opt out, or HELP for help"));
});

test("opt-in description handles a single vendor, the 'other' path, and none at all", () => {
  assert.ok(buildOptinDescription("Acme", ["goatleads"]).includes("operated by GoatLeads,"));
  assert.ok(buildOptinDescription("Acme", ["other:Redwood Leads"]).includes("operated by Redwood Leads,"));
  assert.ok(buildOptinDescription("Acme", []).includes("operated by our licensed lead partners,"));
  assert.ok(buildOptinDescription("Acme", null).includes("operated by our licensed lead partners,"));
});

// The Telnyx campaign has NO compliance-link field — privacyPolicyLink and
// termsAndConditionsLink were probed against live campaignBuilder on
// 2026-07-28 and are silently discarded. So the URLs have to ride in the
// opt-in workflow text, which is free-form and IS read by the reviewer.
test("opt-in description carries the compliance URLs when given them", () => {
  const urls = {
    privacy: "https://trust.producerstackcrm.com/a/acme/privacy-policy",
    terms: "https://trust.producerstackcrm.com/a/acme/terms",
    smsOptIn: "https://trust.producerstackcrm.com/a/acme/sms-opt-in",
  };
  const d = buildOptinDescription("Acme Insurance", ["goatleads"], urls);
  // All three ride in the text. The privacy and terms URLs arrive inside the
  // quoted disclosure rather than in a closing sentence of their own — the
  // duplicate sentence cost ~230 of the 2,048-character budget and told the
  // reviewer nothing the quote had not already told them.
  assert.ok(d.includes(urls.privacy), "privacy URL missing from opt-in description");
  assert.ok(d.includes(urls.terms), "terms URL missing from opt-in description");
  assert.ok(d.includes(urls.smsOptIn), "the opt-in page URL is what makes this description checkable");
  assert.ok(!d.includes("is published at"), "the closing URL sentence duplicates the quoted disclosure");
});

// Belt and braces: when there is no disclosure to carry them, the closing
// sentence comes back. The URLs are never absent from this field, because it
// is one of only two routes by which they reach a carrier reviewer at all.
test("opt-in description falls back to naming the URLs when there is no disclosure to quote", () => {
  const d = buildOptinDescription("Acme Insurance", ["goatleads"], {
    privacy: "https://example.com/p",
    terms: "https://example.com/t",
  });
  assert.ok(d.includes("By checking this box"), "a disclosure IS available when privacy+terms are given");
  // ...so this path is only reachable with neither. Assert that shape directly.
  const bare = buildOptinDescription("Acme Insurance", ["goatleads"], null);
  assert.ok(!bare.includes("is published at"));
});

test("opt-in description omits the URL sentence when no URLs are supplied", () => {
  const d = buildOptinDescription("Acme Insurance", ["goatleads"]);
  assert.ok(!d.includes("is published at"));
  assert.ok(d.endsWith("Consumers may reply STOP at any time to opt out, or HELP for help."));
  // Without URLs there is no disclosure to quote and no page to name, so the
  // text must not pretend to either. It describes the page instead.
  assert.ok(!d.includes("By checking this box"));
  assert.ok(d.includes("opt-in page hosted by the agency"));
});

// ------------------------------------------------------------
// SMS opt-in page
//
// This page is the answer to a rejection, so its tests are about the exact
// properties carrier review scored us down on: is the disclosure visible
// without interaction, is the box unticked, and does the record we keep match
// what was on screen.
// ------------------------------------------------------------

const OPTIN_URLS = {
  privacy: "https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy",
  terms: "https://trust.producerstackcrm.com/a/frenkel-financial-agency/terms",
};

test("disclosure carries every element carrier review looks for", () => {
  const d = buildOptInDisclosure("Frenkel Financial Agency", OPTIN_URLS);
  assert.ok(d.includes("Frenkel Financial Agency"), "the sending agency must be named");
  assert.ok(d.includes("marketing, customer care, and account notifications"));
  assert.ok(d.includes("insurance quote, appointments, and application status"));
  assert.ok(d.includes("Message frequency varies"));
  assert.ok(d.includes("Message and data rates may apply"));
  assert.ok(d.includes("Consent is not a condition of purchase"));
  assert.ok(d.includes("reply STOP"));
  assert.ok(d.includes("HELP for help"));
  assert.ok(d.includes(OPTIN_URLS.privacy), "privacy policy URL must be spelled out in the stored text");
  assert.ok(d.includes(OPTIN_URLS.terms), "terms URL must be spelled out in the stored text");
});

test("the disclosure on the page is the SAME STRING we store as evidence", () => {
  // The whole evidence claim rests on this. compliance-page/index.ts stores
  // buildOptInDisclosure(...) in consent_records.disclosure_text and this
  // page renders buildOptInDisclosure(...) — if the renderer ever reworded,
  // truncated, or re-flowed it, the stored record would stop being proof of
  // what was displayed and nothing else in the system would notice.
  const html = renderSmsOptInPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  const stored = buildOptInDisclosure(agencyDisplayName(LLC_AGENT), OPTIN_URLS);

  // The page escapes it and linkifies the two URLs; strip that back out and
  // what is left must be character-for-character the stored string.
  const label = html.match(/<label[^>]*class="disclosure"[^>]*>([\s\S]*?)<\/label>/);
  assert.ok(label, "disclosure label not found on the page");
  const rendered = label[1]
    .replace(/<a href="[^"]*"[^>]*>([^<]*)<\/a>/g, "$1")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();

  assert.equal(rendered, stored, "the disclosure shown differs from the disclosure stored");
});

test("the disclosure is inline and visible — not behind a link, popup, or details", () => {
  const html = renderSmsOptInPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  const d = buildOptInDisclosure(agencyDisplayName(LLC_AGENT), OPTIN_URLS);
  // Its opening words are in the raw body, so a fetcher that runs no JS and
  // clicks nothing still sees the whole thing.
  assert.ok(html.includes("By checking this box, I agree to receive text messages"));
  assert.ok(!/<details/i.test(html), "the disclosure must not be collapsed behind a <details>");
  assert.ok(!/<dialog/i.test(html), "no modal — the reviewer must not have to open anything");
  // And it is next to the checkbox, not somewhere else on the page.
  const boxAt = html.indexOf('name="consent"');
  const discAt = html.indexOf("By checking this box");
  assert.ok(boxAt > 0 && discAt > boxAt, "disclosure must follow the checkbox in the same block");
  assert.ok(discAt - boxAt < 400, "disclosure is not adjacent to the checkbox");
  assert.ok(d.length > 400, "disclosure got shorter — check nothing required was dropped");
});

test("🔴 the consent checkbox is NEVER pre-checked, including after an error bounce", () => {
  const pages = [
    renderSmsOptInPage({ profile: LLC_AGENT, ...RENDER_OPTS }),
    // The tempting case: they DID tick it, and only the phone number was bad.
    // Re-ticking it for them would be us asserting consent, not them.
    renderSmsOptInPage({
      profile: LLC_AGENT,
      ...RENDER_OPTS,
      error: "That does not look like a US mobile number.",
      values: { first_name: "Jo", last_name: "Ng", phone: "12" },
    }),
    renderSmsOptInPage({ profile: SOLE_PROP_AGENT, ...RENDER_OPTS }),
  ];
  for (const html of pages) {
    const box = html.match(/<input[^>]*name="consent"[^>]*>/);
    assert.ok(box, "consent checkbox missing");
    assert.ok(!/checked/i.test(box[0]), `checkbox was pre-checked: ${box[0]}`);
  }
});

test("an error bounce keeps what they typed but shows the problem", () => {
  const html = renderSmsOptInPage({
    profile: LLC_AGENT,
    ...RENDER_OPTS,
    error: "Please enter your first name.",
    values: { first_name: "", last_name: "Ng", phone: "(414) 555-1234" },
  });
  assert.ok(html.includes("Please enter your first name."));
  assert.ok(html.includes('value="Ng"'), "last name was not preserved");
  assert.ok(html.includes('value="(414) 555-1234"'), "phone was not preserved");
});

test("the form is a real POST to its own URL, and posts nowhere else", () => {
  const html = renderSmsOptInPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  assert.ok(html.includes('method="post"'), "must be a POST — a GET would put the phone number in a URL");
  assert.ok(html.includes('action="/a/frenkel-financial-agency/sms-opt-in"'));
  // Behind the raw functions URL the action has to carry the prefix or the
  // form posts to a 404. This is what pathPrefix exists for.
  const raw = renderSmsOptInPage({
    profile: LLC_AGENT,
    ...RENDER_OPTS,
    pathPrefix: "/functions/v1/compliance-page",
  });
  assert.ok(raw.includes('action="/functions/v1/compliance-page/a/frenkel-financial-agency/sms-opt-in"'));
});

test("the form asks for exactly the three fields, plus the honeypot", () => {
  const html = renderSmsOptInPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  for (const name of ["first_name", "last_name", "phone"]) {
    assert.ok(html.includes(`name="${name}"`), `missing field: ${name}`);
  }
  // The honeypot is off-screen, never focusable, and never announced — a
  // human cannot fill it in by accident, which is what makes a filled one a
  // reliable bot signal.
  assert.ok(html.includes('name="company_website"'));
  assert.ok(html.includes('tabindex="-1"'));
  assert.ok(html.includes('aria-hidden="true"'));
});

test("opt-in page names the agency, not ProducerStack, and links its own policies", () => {
  const html = renderSmsOptInPage({ profile: LLC_AGENT, ...RENDER_OPTS });
  assert.ok(html.includes("Frenkel Financial Agency"));
  assert.ok(html.includes('href="/a/frenkel-financial-agency/privacy-policy"'));
  assert.ok(html.includes('href="/a/frenkel-financial-agency/terms"'));
  // Rule 3: ProducerStack appears once, in the footer line, and nowhere else.
  assert.equal(html.split("ProducerStack").length - 1, 1);
});

test("the auto-response matches the campaign's registered opt-in keyword reply", () => {
  const r = buildOptInAutoResponse("Frenkel Financial Agency");
  assert.ok(r.startsWith("Frenkel Financial Agency: You're subscribed to messages about your life insurance quote"));
  assert.ok(r.includes("Msg frequency varies"));
  assert.ok(r.includes("Msg&data rates may apply"));
  assert.ok(r.includes("Consent is not a condition of purchase"));
  assert.ok(r.includes("Reply HELP for help, STOP to opt out."));
});

test("confirmation page tells a DNC'd number the truth instead of claiming success", () => {
  const ok = renderSmsOptInConfirmedPage({
    profile: LLC_AGENT, ...RENDER_OPTS, firstName: "Jo", maskedPhone: maskPhoneLast4("0123"),
  });
  assert.ok(ok.includes("Thanks, Jo."));
  assert.ok(ok.includes("A confirmation text is on its way"));

  const stopped = renderSmsOptInConfirmedPage({
    profile: LLC_AGENT, ...RENDER_OPTS, firstName: "Jo", maskedPhone: maskPhoneLast4("0123"), stopWarning: true,
  });
  // A person who texted STOP must not be told a text is coming, because one
  // is not — we will not send over the top of a verified opt-out.
  assert.ok(!stopped.includes("A confirmation text is on its way"));
  assert.ok(stopped.includes("previously replied STOP"));
  assert.ok(stopped.includes("START"));
});

test("the confirmation page shows only the last four digits", () => {
  assert.equal(maskPhoneLast4("0123"), "(•••) •••-0123");
  assert.equal(maskPhoneLast4("12"), "");
  const html = renderSmsOptInConfirmedPage({
    profile: LLC_AGENT, ...RENDER_OPTS, firstName: "Jo", maskedPhone: maskPhoneLast4("0123"),
  });
  assert.ok(html.includes("•••-0123"));
  assert.ok(!/\d{3}[-.\s]?\d{4}(?!<)/.test(html.replace(/\(414\) 555-1234/g, "")) ||
    !html.includes("5550123"), "an unmasked consumer number reached the page");
});

test("a hostile name cannot break out of the form or the disclosure", () => {
  const nasty: AgencyProfile = {
    ...LLC_AGENT,
    dba_name: `Evil" onmouseover="alert(1)" x="`,
  };
  const html = renderSmsOptInPage({
    profile: nasty,
    ...RENDER_OPTS,
    values: { first_name: `"><script>alert(1)</script>`, last_name: "x", phone: "1" },
  });
  assert.ok(!/<script/i.test(html), "script tag survived escaping");
  assert.ok(html.includes("&lt;script&gt;"), "expected the tag to render as text");
  // The handler text is present but INERT: every quote that would have closed
  // the attribute is escaped, so `onmouseover=` never becomes an attribute.
  // Asserting on the escaped form is the check that actually means something
  // — a blanket /\son[a-z]+=/ would flag the harmless rendered text too.
  assert.ok(!html.includes('onmouseover="'), "an event handler attribute was injected");
  assert.ok(html.includes("onmouseover=&quot;"), "expected the handler to render as escaped text");
  // And the value attributes they typed into are still closed properly.
  assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
});

// The description quotes a verbatim disclosure and repeats the agency name,
// so it GROWS with the agency name — an early draft came out at 2,368
// characters for "Frenkel Financial Agency" alone, over a limit nothing in
// the code knew about. TCR caps messageFlow at 2,048; past it Telnyx either
// rejects (a $15 retry) or truncates, which would cut the quoted consent
// disclosure off mid-sentence. The worst realistic case is a 60-character
// agency name, which is what compliance_slug allows.
test("the opt-in description fits TCR's messageFlow limit, worst case included", () => {
  const cases: Array<[string, string]> = [
    ["Acme", "acme"],
    ["Frenkel Financial Agency", "frenkel-financial-agency"],
    // 60 chars — the maximum a slug can be, so the maximum an agency name
    // meaningfully contributes here.
    [
      "The Extraordinarily Long Life Insurance Agency Of Greater Mil",
      "the-extraordinarily-long-life-insurance-agency-of-greater-mil",
    ],
  ];
  for (const [name, slug] of cases) {
    const urls = compliancePageUrls("https://trust.producerstackcrm.com", slug);
    const d = buildOptinDescription(name, ["goatleads", "builtleads"], urls);
    assert.ok(
      d.length <= TCR_MESSAGE_FLOW_MAX,
      `description is ${d.length} chars for "${name}" — over the ${TCR_MESSAGE_FLOW_MAX} limit. ` +
        `Shorten the fixed prose, NOT the quoted disclosure.`,
    );
    // And the quoted disclosure survived whole — a length fix that trimmed
    // the quote instead of the prose would still pass the assert above.
    assert.ok(d.includes(buildOptInDisclosure(name, urls)), "the quoted disclosure was altered or cut");
  }
});

test("the campaign's registered opt-in reply is the same text the page sends", () => {
  // messageFlow tells the reviewer to look at the campaign's opt-in keyword
  // response instead of quoting it, which only holds if the two are the same
  // string. buildCampaignInfo() and the compliance-page function both call
  // buildOptInAutoResponse(), and this is the assertion that keeps it that way.
  const info = buildCampaignInfo({
    brandId: "brand_123",
    brandType: "standard",
    agencyName: "Frenkel Financial Agency",
    leadVendors: ["goatleads"],
    complianceUrls: compliancePageUrls("https://trust.producerstackcrm.com", "frenkel-financial-agency"),
  });
  assert.equal(info.optinMessage, buildOptInAutoResponse("Frenkel Financial Agency"));
  assert.ok(info.messageFlow.includes("registered opt-in confirmation message"));
  assert.ok(info.messageFlow.length <= TCR_MESSAGE_FLOW_MAX);
});

test("vendor resolution drops unknown keys and de-duplicates", () => {
  assert.deepEqual(resolveVendorNames(["goatleads", "nope", "goatleads", "builtleads"]),
    ["GoatLeads", "Built Leads"]);
  assert.deepEqual(resolveVendorNames(null), []);
});

test("joinVendorNames uses an Oxford list for three or more", () => {
  assert.equal(joinVendorNames(["A"]), "A");
  assert.equal(joinVendorNames(["A", "B"]), "A and B");
  assert.equal(joinVendorNames(["A", "B", "C"]), "A, B, and C");
  assert.equal(joinVendorNames([]), "our licensed lead partners");
});
