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
  compliancePageUrls,
  entityClause,
  escapeHtml,
  formatPhoneDisplay,
  isValidSlug,
  missingComplianceFields,
  renderIndexPage,
  renderNotFoundPage,
  renderPrivacyPolicyPage,
  renderTermsPage,
  slugifyAgencyName,
  stateName,
  type AgencyProfile,
} from "./compliance-page.ts";

import { buildOptinDescription, joinVendorNames, resolveVendorNames } from "./lead-vendors.ts";

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
  // A reviewer comparing the two must see the same vendors and the same
  // TrustedForm claim. Divergence here is a rejection.
  assert.ok(html.includes("GoatLeads and Built Leads"));
  assert.ok(optin.includes("GoatLeads and Built Leads"));
  assert.ok(html.includes("TrustedForm"));
  assert.ok(optin.includes("TrustedForm"));
});

test("every page shows a Last updated date", () => {
  for (const html of allPages(LLC_AGENT)) {
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

test("compliancePageUrls builds the three canonical URLs and tolerates a trailing slash", () => {
  assert.deepEqual(compliancePageUrls("https://trust.producerstackcrm.com/", "acme-agency"), {
    index: "https://trust.producerstackcrm.com/a/acme-agency",
    privacy: "https://trust.producerstackcrm.com/a/acme-agency/privacy-policy",
    terms: "https://trust.producerstackcrm.com/a/acme-agency/terms",
  });
});

// ------------------------------------------------------------
// Opt-in description (Phase 5)
// ------------------------------------------------------------

test("opt-in description substitutes vendor and agency, keeps the fixed body", () => {
  const d = buildOptinDescription("Frenkel Financial Agency", ["goatleads", "builtleads"]);
  assert.ok(d.startsWith("Consumers request life insurance information by completing a web form operated by GoatLeads and Built Leads"));
  assert.ok(d.includes("prior express written consent"));
  assert.ok(d.includes("certified by TrustedForm"));
  assert.ok(d.includes("IP address, session activity, timestamp"));
  assert.ok(d.includes("does not send messages to any lead without a stored consent record"));
  assert.ok(d.endsWith("Consumers may reply STOP at any time to opt out."));
});

test("opt-in description handles a single vendor, the 'other' path, and none at all", () => {
  assert.ok(buildOptinDescription("Acme", ["goatleads"]).includes("operated by GoatLeads,"));
  assert.ok(buildOptinDescription("Acme", ["other:Redwood Leads"]).includes("operated by Redwood Leads,"));
  assert.ok(buildOptinDescription("Acme", []).includes("operated by our licensed lead partners,"));
  assert.ok(buildOptinDescription("Acme", null).includes("operated by our licensed lead partners,"));
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
