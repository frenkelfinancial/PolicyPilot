// ============================================================
// office-split.test.mjs — run with:  npm run test:office
//
// The Front Office / Back Office split (Round 1). Same shape as the
// STRUCTURE half of test/back-office.test.mjs: app.html has no build step and
// no module system, so the only honest way to test the sidebar is to read the
// file that ships and assert against it as source text.
//
// These are regression tests for the bug CLASSES this split is exposed to:
//
//   * a screen that belongs to no office — invisible in both, and nothing
//     else in the app would ever tell you;
//   * a nav item inside one office's wrapper tagged with the other's name;
//   * a bare querySelector for the nav highlight, now that Agency exists
//     TWICE in the DOM (that is the duplicate-Agency bug, see test 8);
//   * the `backoffice` id being renamed along with its label — sec-backoffice,
//     renderBackOffice(), boArea(), the bopanel-* prefixes,
//     test/back-office.test.mjs and every docs/back-office-*.md key off it.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');

// ------------------------------------------------------------
// Slicing helpers — no DOM here, so the markup is walked as text.
// ------------------------------------------------------------

// The sidebar, between its two marker comments.
const SIDEBAR = (() => {
  const a = APP.indexOf('<!-- SIDEBAR -->');
  const b = APP.indexOf('<!-- MAIN -->', a);
  assert.ok(a > -1 && b > a, 'app.html must contain the <!-- SIDEBAR --> … <!-- MAIN --> markers');
  return APP.slice(a, b);
})();

// A <div …> … </div> block with balanced nesting, starting at `openTag`.
function divBlock(src, openTag) {
  const start = src.indexOf(openTag);
  assert.ok(start > -1, `expected to find ${openTag}`);
  let i = start + openTag.length;
  let depth = 1;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = i;
  let m;
  while ((m = tag.exec(src)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index + m[0].length);
  }
  assert.fail(`unbalanced <div> after ${openTag}`);
}

const FRONT_BLOCK = divBlock(SIDEBAR, '<div class="nav-office" data-office="front">');
const BACK_BLOCK  = divBlock(SIDEBAR, '<div class="nav-office" data-office="back">');

// Every <div class="nav-item …"> opening tag inside a slice.
const navItemTags = slice => slice.match(/<div class="nav-item[^>]*>/g) || [];
// The visible label of each, in order.
const navLabels = slice =>
  [...slice.matchAll(/<span class="nav-lbl-text">([^<]*)<\/span>/g)].map(m => m[1]);

// A top-level `function name(…) { … }` body. The app indents every line inside
// a function, so a lone `}` in column 0 is the closing brace.
function fnBody(header) {
  const start = APP.indexOf(header);
  assert.ok(start > -1, `expected to find "${header}" in app.html`);
  const end = APP.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of "${header}"`);
  return APP.slice(start, end);
}

// Same body with whole-line comments removed. Every rule here is documented in
// a comment right beside the code that obeys it, so counting comment text as a
// violation would make writing the rule down break it.
const codeOnly = src => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

// The office map, evaluated from the source that ships rather than mirrored.
const OFFICES = (() => {
  const mapSrc   = APP.match(/const OFFICE_OF = \{[\s\S]*?\n\};/);
  const homeSrc  = APP.match(/const OFFICE_HOME = \{[^}]*\};/);
  const defSrc   = APP.match(/const DEFAULT_OFFICE = '[a-z]+';/);
  const titleSrc = APP.match(/const NAV_TITLES = \{[\s\S]*?\n\};/);
  assert.ok(mapSrc,   'app.html must declare const OFFICE_OF');
  assert.ok(homeSrc,  'app.html must declare const OFFICE_HOME');
  assert.ok(defSrc,   'app.html must declare const DEFAULT_OFFICE');
  assert.ok(titleSrc, 'app.html must declare const NAV_TITLES');
  // eslint-disable-next-line no-new-func
  return new Function(
    `${mapSrc[0]}\n${homeSrc[0]}\n${defSrc[0]}\n${titleSrc[0]}\n` +
    'return { OFFICE_OF, OFFICE_HOME, DEFAULT_OFFICE, NAV_TITLES };'
  )();
})();

const { OFFICE_OF, OFFICE_HOME, DEFAULT_OFFICE, NAV_TITLES } = OFFICES;

// Sections that exist only once the app injects them at runtime.
const DYNAMIC_SECTIONS = ['ai-test', 'voice-campaigns', 'ds-playground'];

// ============================================================
// 1 + 2 — the two nav lists, exactly
// ============================================================

test('Front Office static nav is exactly the seven selling screens', () => {
  assert.deepEqual(navLabels(FRONT_BLOCK), [
    'Summary',
    'Leads',
    'Quote + Underwriting',
    'Calendar',
    'Web Dialer',
    'Phone Book',
    'Agency',
  ]);
});

test('Back Office static nav opens with its own Summary, then the five money screens', () => {
  // Round 2 added Summary at the top — a genuine change in the expected list.
  // It is OFFICE_HOME.back, so it must be the FIRST item: the screen you land
  // on and the item that lights up have to be the same one.
  assert.deepEqual(navLabels(BACK_BLOCK), [
    'Summary',
    'Policy Tracker',
    'Carrier Mail',
    'Statements',
    'Bonus Tracker',
    'Agency',
  ]);
});

test('the Back Office lands on its own Summary, not on the Policy Tracker placeholder', () => {
  const m = APP.match(/const OFFICE_HOME = \{([^}]*)\}/);
  assert.ok(m, 'OFFICE_HOME must still be declared exactly once');
  assert.match(m[1], /back:\s*'bo-summary'/,
    "Round 1 parked the Back Office on 'tracker' as a placeholder; Round 2 replaced it");
  assert.match(m[1], /front:\s*'summary'/, 'the Front Office landing screen does not change');
  // And the home screen has to be reachable, or the toggle lands nowhere.
  assert.match(APP, /<div class="section" id="sec-bo-summary">/);
});

// ============================================================
// 3 — the runtime injections land in the Front Office's Outreach group
// ============================================================

test('Voice Campaigns and AI Dialer Test inject into #nav-group-outreach as Front Office items', () => {
  assert.match(FRONT_BLOCK, /<div class="nav-sec" id="nav-group-outreach">/,
    'the Outreach group must live inside the Front Office wrapper');
  assert.ok(!BACK_BLOCK.includes('nav-group-outreach'),
    'the Outreach group must not be in the Back Office');

  const init = fnBody('async function aiTestInit()');
  assert.match(init, /getElementById\('nav-group-outreach'\)/,
    'aiTestInit() must resolve the Outreach group, not the Settings item');
  assert.ok(!init.includes(".nav-item[onclick*=\"settings\"]"),
    'aiTestInit() must no longer inject next to Settings — Settings is in neither office');

  // Both items tagged individually as well as sitting inside the wrapper.
  assert.match(init, /a\.dataset\.office = 'front';/, 'AI Dialer Test must be tagged office=front');
  assert.match(init, /v\.dataset\.office = 'front';/, 'Voice Campaigns must be tagged office=front');
  assert.match(init, /outreachGroup\.appendChild\(a\)/);
  assert.match(init, /outreachGroup\.appendChild\(v\)/);

  // Office visibility re-applied so an item injected while the agent is in the
  // Back Office is hidden the instant it appears rather than flashing in.
  assert.match(init, /setOffice\(document\.body\.dataset\.office, \{ silent: true \}\)/);
});

test('the AI dialer double kill switch is untouched', () => {
  const init = fnBody('async function aiTestInit()');
  assert.match(init, /if \(!\(agentOn && globalOn\)\) return;/,
    'both switches must still be required, and by a strict AND');
});

test('ds-playground stays beside Settings, in neither office', () => {
  const init = fnBody('function dsInitPlayground()');
  assert.match(init, /\.nav-item\[onclick\*="settings"\]/,
    'the dev tool is not a product screen — it stays next to Settings');
  assert.ok(!/a\.dataset\.office/.test(init),
    'ds-playground must carry no data-office, so it shows in both offices');
});

// ============================================================
// 4 — every item inside an office wrapper is tagged with that office
// ============================================================

test('every .nav-item inside a .nav-office carries a matching data-office', () => {
  for (const [office, block] of [['front', FRONT_BLOCK], ['back', BACK_BLOCK]]) {
    const tags = navItemTags(block);
    assert.ok(tags.length > 0, `the ${office} office must contain nav items`);
    for (const tag of tags) {
      assert.ok(
        tag.includes(`data-office="${office}"`),
        `nav item in the ${office} office is missing data-office="${office}":\n  ${tag}\n` +
        'Belt and braces: the wrapper hides the block, the attribute is what lets a ' +
        'dynamically injected item be tagged one at a time.'
      );
    }
  }
});

// ============================================================
// 5 — the map is complete in both directions
// ============================================================

test('every nav target in the sidebar has an OFFICE_OF entry', () => {
  const targets = [...SIDEBAR.matchAll(/onclick="nav\('([^']+)'\)"/g)].map(m => m[1]);
  assert.ok(targets.length > 0);
  for (const t of new Set(targets)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(OFFICE_OF, t),
      `nav('${t}') has no OFFICE_OF entry — a nav item with no office is invisible in BOTH offices`
    );
  }
});

test('every OFFICE_OF key resolves to a real section', () => {
  for (const key of Object.keys(OFFICE_OF)) {
    const ok = APP.includes(`id="sec-${key}"`) || DYNAMIC_SECTIONS.includes(key);
    assert.ok(ok, `OFFICE_OF names "${key}" but there is no #sec-${key} and it is not a documented dynamic section`);
  }
});

test('OFFICE_OF agrees with the wrapper each nav item is actually rendered in', () => {
  // The map is what nav(), setOffice() and both restore paths reason about;
  // the wrapper is what the agent sees. A section filed under 'front' but
  // rendered inside the Back Office block would flip the toggle on click and
  // then hide the item you clicked — visible nowhere else in the app.
  for (const [office, block] of [['front', FRONT_BLOCK], ['back', BACK_BLOCK]]) {
    const targets = [...block.matchAll(/onclick="nav\('([^']+)'\)"/g)].map(m => m[1]);
    for (const t of targets) {
      const declared = OFFICE_OF[t];
      assert.ok(
        declared === office || declared === 'both',
        `nav('${t}') is rendered in the ${office} office but OFFICE_OF says '${declared}'`
      );
    }
  }
  // 'both' must mean rendered twice, once per office — not filed as shared and
  // then shown in one place.
  for (const [key, val] of Object.entries(OFFICE_OF)) {
    if (val !== 'both') continue;
    const inSidebar = (SIDEBAR.match(new RegExp(`onclick="nav\\('${key}'\\)"`, 'g')) || []).length;
    if (!inSidebar) continue;                       // settings lives in .sidebar-bot
    const inFront = FRONT_BLOCK.includes(`nav('${key}')`);
    const inBack  = BACK_BLOCK.includes(`nav('${key}')`);
    assert.ok(inFront === inBack,
      `OFFICE_OF.${key} is 'both' but it is rendered in only one office wrapper`);
  }
});

test('there is exactly one Outreach group for the injections to find', () => {
  assert.equal((APP.match(/id="nav-group-outreach"/g) || []).length, 1);
});

test('OFFICE_OF values are only front, back or both', () => {
  for (const [key, val] of Object.entries(OFFICE_OF)) {
    assert.ok(['front', 'back', 'both'].includes(val), `OFFICE_OF.${key} = ${val}`);
  }
});

// ============================================================
// 6 — Agency, twice
// ============================================================

test('Agency appears once per office, with the ids future sessions look for', () => {
  const agencyItems = [...SIDEBAR.matchAll(/<div class="nav-item"[^>]*onclick="nav\('agency'\)"/g)];
  assert.equal(agencyItems.length, 2, 'Agency must be rendered in BOTH offices — two nav items, one #sec-agency');
  assert.match(FRONT_BLOCK, /id="nav-agency-front"/);
  assert.match(BACK_BLOCK,  /id="nav-agency-back"/);
  assert.equal((APP.match(/id="sec-agency"/g) || []).length, 1, 'there is still exactly one Agency section');
});

// ============================================================
// 7 — Settings and Support belong to neither office
// ============================================================

test('Support and Settings sit outside both offices and carry no data-office', () => {
  const bot = SIDEBAR.slice(SIDEBAR.indexOf('<div class="sidebar-bot">'));
  assert.match(bot, /onclick="openSupportModal\(\)"/);
  assert.match(bot, /onclick="nav\('settings'\)"/);
  assert.ok(!bot.includes('data-office'), 'nothing in .sidebar-bot may be scoped to an office');
  for (const block of [FRONT_BLOCK, BACK_BLOCK]) {
    assert.ok(!block.includes("nav('settings')"), 'Settings must not be inside a .nav-office');
    assert.ok(!block.includes('openSupportModal()'), 'Support must not be inside a .nav-office');
  }
});

// ============================================================
// 8 — the duplicate-Agency regression test
// ============================================================

const HIGHLIGHT_WHY =
  'Agency is now rendered TWICE in the sidebar (#nav-agency-front and #nav-agency-back). ' +
  'document.querySelector returns only the FIRST match, so clicking Agency from the Back ' +
  'Office would highlight the Front Office copy and leave the one you clicked dark. ' +
  'Highlight by section name, and by ALL matches.';

for (const [label, header] of [
  ['nav()',                      'function nav(id) {'],
  ['_applyPlanGating()',         'function _applyPlanGating()'],
  ['restoreSectionFromCache()',  'function restoreSectionFromCache()'],
]) {
  test(`${label} resolves nav items with querySelectorAll, not querySelector`, () => {
    const body = codeOnly(fnBody(header));
    assert.ok(
      body.includes(`document.querySelectorAll('.nav-item[onclick`),
      `${label} must select nav items with querySelectorAll. ${HIGHLIGHT_WHY}`
    );
    assert.ok(
      !body.includes(`document.querySelector('.nav-item[onclick`),
      `${label} still contains a singular querySelector('.nav-item[onclick…'). ${HIGHLIGHT_WHY}`
    );
  });
}

// ============================================================
// 9 — the label moved, the id did not
// ============================================================

test('the Statements tab is labelled Statements and keyed backoffice', () => {
  assert.equal(NAV_TITLES.backoffice, 'Statements');
  for (const [key, val] of Object.entries(NAV_TITLES)) {
    assert.notEqual(val, 'Back Office', `NAV_TITLES.${key} still reads "Back Office"`);
  }
  // The id is load-bearing in a dozen places outside this file.
  assert.match(APP, /id="sec-backoffice"/);
  assert.match(SIDEBAR, /onclick="nav\('backoffice'\)"/);
  assert.equal(OFFICE_OF.backoffice, 'back');
});

// ============================================================
// 10 — the landing decisions
// ============================================================

test('a fresh session opens in the Front Office, on Summary', () => {
  assert.equal(DEFAULT_OFFICE, 'front');
  assert.equal(OFFICE_HOME.front, 'summary');
  // Round 2 replaced the 'tracker' placeholder with the real Back Office
  // Summary. Each office now lands on its own overview screen.
  assert.equal(OFFICE_HOME.back, 'bo-summary');
  assert.equal(OFFICE_OF['bo-summary'], 'back');
});

test('the office is remembered in sessionStorage, never localStorage', () => {
  const body = codeOnly(fnBody('function setOffice(office, opts)'));
  assert.match(body, /sessionStorage\.setItem\('pp_office', office\)/);
  assert.ok(!body.includes('localStorage'),
    'a fresh login or a new tab must start in the Front Office — that is what sessionStorage buys');
});

test('office visibility is CSS, never an inline style', () => {
  assert.match(APP, /body\[data-office="front"\] \.nav-office\[data-office="back"\]/);
  assert.match(APP, /body\[data-office="back"\] {2}\.nav-item\[data-office="front"\]/);
  const body = codeOnly(fnBody('function setOffice(office, opts)'));
  assert.ok(!body.includes('style.display'),
    'setOffice() must not write style.display — plan gating owns the inline layer, ' +
    'and an inline none there is what correctly outranks the office rule.');
});

test('nav() flips the office before it navigates, so cross-office deep links work', () => {
  const body = fnBody('function nav(id) {');
  assert.match(body, /const _wantOffice = OFFICE_OF\[id\];/);
  assert.match(body, /setOffice\(_wantOffice, \{ silent: true \}\)/);
  // The flip must come before the plan gate returns, or a gated section would
  // leave the toggle half-moved.
  assert.ok(body.indexOf('_wantOffice') < body.indexOf('const _navTier'),
    'the office flip must be the first thing nav() does');
});
