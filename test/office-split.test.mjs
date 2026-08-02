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

// The same, also dropping /** … */ doc-block lines — the block above
// _isRestorableSection() names the dead `const valid = {…}` on purpose.
const APP_CODE = APP.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

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

test('both offices land on the SAME Summary', () => {
  // History: Round 1 parked the Back Office on 'tracker' as a placeholder,
  // Round 2 built it a Summary of its own, and the owner replaced that with
  // the Front Office's on 2026-08-01 — one overview screen, reachable from
  // either office, instead of two that had to be kept telling the same story.
  const m = APP.match(/const OFFICE_HOME = \{([^}]*)\}/);
  assert.ok(m, 'OFFICE_HOME must still be declared exactly once');
  assert.match(m[1], /front:\s*'summary'/, 'the Front Office landing screen does not change');
  assert.match(m[1], /back:\s*'summary'/,
    'the Back Office lands on the Front Office Summary — not on a second one');
  // And the home screen has to be reachable, or the toggle lands nowhere.
  assert.match(APP, /<div class="section[^"]*" id="sec-summary">/);
});

test('the Back Office Summary screen is still in the file — it is only unreachable', () => {
  // The owner chose to leave the code in place rather than delete ~2,800 lines.
  // So this must keep passing: the screen, its renderer and its two pure cores
  // are still here and test/bo-summary.test.mjs still runs against them. What
  // changed is that nothing in the sidebar points at it.
  assert.match(APP, /<div class="section" id="sec-bo-summary">/);
  assert.match(APP, /function renderBackOfficeSummary\(/);
  assert.equal(OFFICE_OF['bo-summary'], 'back', 'it still declares an office');
  // Match nav ITEMS, not raw text: the sidebar comment explaining the change
  // necessarily names nav('bo-summary'), and a substring check on the whole
  // block cannot tell a note from a navigation target.
  // class="nav-item active" on the Front Office's Summary, so match the class
  // loosely — a bare `class="nav-item"` silently skips the default item.
  const navTargets = [...SIDEBAR.matchAll(/<div class="nav-item[^"]*"[^>]*onclick="nav\('([^']+)'\)"/g)]
    .map(m => m[1]);
  assert.ok(!navTargets.includes('bo-summary'),
    'no sidebar item may point at the retired Back Office Summary');
  assert.ok(navTargets.filter(t => t === 'summary').length >= 2,
    "'both' means rendered twice — one Summary item per office, against one #sec-summary");
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
  // Round 2 replaced the 'tracker' placeholder with a Back Office Summary of
  // its own; 2026-08-01 replaced THAT with the Front Office's. Both offices
  // land on one overview screen, which is why it is filed under 'both'.
  assert.equal(OFFICE_HOME.back, 'summary');
  assert.equal(OFFICE_OF.summary, 'both');
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

// ============================================================
// 11 — the refresh restore allow-list (Round 3)
//
// A refresh used to consult `const valid = {…}` in bootDashboard() — a THIRD
// hand-written copy of the sidebar, after the positional idxMap and the map
// restoreSectionFromCache() used to carry. It had drifted four entries behind:
// Carrier Mail, Statements, Voice Campaigns and AI Dialer Test were all
// missing, so refreshing on any of them left restoreSectionFromCache()'s
// pre-auth swap on screen with nothing ever calling the screen's renderer.
//
// The membership test is now DERIVED from the sidebar. These tests execute the
// shipped restore block against a stub DOM built from the real markup, so they
// fail on the code that ships rather than on a copy of it.
// ============================================================

// A `function name(…) { … }` INCLUDING its closing brace, ready to execute.
function fnSource(header) {
  return fnBody(header) + '\n}';
}

// From `startNeedle`, the statement beginning at `openNeedle`, brace-balanced.
function sliceBalanced(src, startNeedle, openNeedle) {
  const s = src.indexOf(startNeedle);
  assert.ok(s > -1, `expected to find ${JSON.stringify(startNeedle)} in app.html`);
  const o = src.indexOf(openNeedle, s);
  assert.ok(o > -1, `expected to find ${JSON.stringify(openNeedle)} after it`);
  let depth = 0;
  for (let i = src.indexOf('{', o); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(s, i + 1);
  }
  return assert.fail(`unbalanced braces after ${JSON.stringify(openNeedle)}`);
}

// The derived predicate itself.
const IS_RESTORABLE_SRC = fnSource('function _isRestorableSection(id) {');

// bootDashboard()'s restore block, verbatim.
const RESTORE_SRC = (() => {
  const head = "const saved = localStorage.getItem(k('pp_current_section'));";
  const tail = 'nav(tabParam);';
  const a = APP.indexOf(head);
  assert.ok(a > -1, "bootDashboard() must still read k('pp_current_section')");
  const b = APP.indexOf(tail, a);
  assert.ok(b > a, 'the ?tab= branch must still close the restore block');
  return APP.slice(a, b + tail.length);
})();

// aiTestInit()'s late restore, verbatim.
const LATE_RESTORE_SRC = sliceBalanced(
  APP, 'const _late = _pendingLateRestore;', 'if (_late &&');

// Every section the SHIPPED sidebar actually navigates to. The stub DOM
// answers from this, so "is there a nav item" means the real markup.
const STATIC_NAV_TARGETS = [...SIDEBAR.matchAll(/onclick="nav\('([^']+)'\)"/g)].map(m => m[1]);

// Minimal DOM: enough for `.nav-item[onclick*="nav('x')"]` and body.dataset.
function stubDoc(office, navTargets) {
  return {
    body: { dataset: { office } },
    querySelectorAll(sel) {
      const m = /onclick\*="nav\('([^']+)'\)"/.exec(sel);
      if (!m) return [];
      return navTargets.includes(m[1]) ? [{ id: `nav-${m[1]}` }] : [];
    },
  };
}

/** Execute the shipped boot restore. Returns where it navigated, if anywhere. */
function runBootRestore({ saved, office, tier = 'leader', search = '', navTargets = STATIC_NAV_TARGETS }) {
  const navCalls = [];
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'k', 'localStorage', 'location', 'document', 'OFFICE_OF', '_planTier', 'nav',
    `let _pendingLateRestore = null;\n${IS_RESTORABLE_SRC}\n${RESTORE_SRC}\n` +
    'return { pending: _pendingLateRestore };'
  );
  const out = fn(
    key => key,
    { getItem: key => (key === 'pp_current_section' ? saved : null) },
    { search },
    stubDoc(office, navTargets),
    OFFICE_OF,
    () => tier,
    id => navCalls.push(id),
  );
  return { navCalls, pending: out.pending };
}

/** Execute the shipped late restore, as reached from inside the kill-switch gate. */
function runLateRestore({ pending, office, navTargets }) {
  const navCalls = [];
  const shows = [];
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    '_pendingLateRestore', 'document', 'OFFICE_OF', 'nav', 'aiTestOnShow',
    `${IS_RESTORABLE_SRC}\n${LATE_RESTORE_SRC}\nreturn { pending: _pendingLateRestore };`
  );
  const out = fn(
    pending,
    stubDoc(office, navTargets),
    OFFICE_OF,
    id => navCalls.push(id),
    () => shows.push('ai-test'),
  );
  return { navCalls, shows, pending: out.pending };
}

const NO_HAND_LIST_WHY =
  'A hand-written copy of the sidebar is the bug this round removed, and it has now come back ' +
  'THREE times: the positional idxMap in nav(), the map restoreSectionFromCache() carried, and ' +
  '`const valid = {…}` in bootDashboard(). Every one of them drifted, and the copy nobody ' +
  'remembers is always the one that breaks. Derive the membership test from the sidebar.';

test('no hand-written restore allow-list survives in app.html', () => {
  // Comment-stripped: the doc block above _isRestorableSection() quotes the
  // dead declaration by name, and writing a rule down must not break it.
  assert.ok(!APP_CODE.includes('const valid = {'), NO_HAND_LIST_WHY);
  // And the thing that replaced it exists, once.
  assert.equal((APP.match(/function _isRestorableSection\(/g) || []).length, 1,
    'there must be exactly one _isRestorableSection() — a second answer is a fourth copy');
  assert.match(IS_RESTORABLE_SRC, /document\.querySelectorAll\('\.nav-item\[onclick/,
    '_isRestorableSection must resolve nav items the same way nav() does');
});

test('every static sidebar section with an office is restorable — including the two that were missing', () => {
  const doc = stubDoc('front', STATIC_NAV_TARGETS);
  // eslint-disable-next-line no-new-func
  const isRestorable = new Function('document', 'OFFICE_OF',
    `${IS_RESTORABLE_SRC}\nreturn _isRestorableSection;`)(doc, OFFICE_OF);

  for (const id of new Set(STATIC_NAV_TARGETS)) {
    assert.ok(OFFICE_OF[id], `nav('${id}') has no OFFICE_OF entry`);
    assert.ok(isRestorable(id), `a refresh on ${id} must be restorable — it is in the sidebar`);
  }
  // The two the hand-written list had been missing since before the office
  // split. Named explicitly so a future sidebar edit cannot quietly drop them.
  assert.ok(isRestorable('carriermail'), 'Carrier Mail must be restorable');
  assert.ok(isRestorable('backoffice'),  'Statements must be restorable');
  // The retired Back Office Summary is the derived predicate doing its job: it
  // still declares an office and #sec-bo-summary is still in the markup, but
  // nothing in the sidebar navigates to it, so a stale cached 'bo-summary'
  // must fall through to the office home rather than restoring a screen the
  // agent can no longer reach from anywhere.
  assert.ok(!isRestorable('bo-summary'),
    'a section with an office but no sidebar item must not be restorable');
  // And a section nobody navigates to is not restorable just for existing.
  assert.ok(!isRestorable('nope'), 'an unknown id must never be restorable');
  assert.ok(!isRestorable(''),     'an empty id must never be restorable');
});

test('restoring Statements or Carrier Mail calls nav(), which is what draws them', () => {
  // The screens were APPEARING before this round — restoreSectionFromCache()
  // makes the section .active pre-auth — but nothing called their renderer, so
  // the agent got the page chrome and no data. nav() is the only caller.
  for (const [id, renderer] of [['backoffice', 'renderBackOffice()'], ['carriermail', 'renderCarrierMail()']]) {
    const { navCalls } = runBootRestore({ saved: id, office: 'back' });
    assert.deepEqual(navCalls, [id], `a refresh on ${id} must reach nav('${id}')`);
    assert.match(fnBody('function nav(id) {'),
      new RegExp(`if \\(id === '${id}'\\) ${renderer.replace(/[()]/g, '\\$&')}`),
      `nav() is the only caller of ${renderer} — without it the screen appears blank`);
  }
});

test('the office guard still refuses a section belonging to the office we are not in', () => {
  assert.deepEqual(runBootRestore({ saved: 'backoffice', office: 'front' }).navCalls, [],
    'a Back Office screen must not be restored while the toggle reads Front Office');
  assert.deepEqual(runBootRestore({ saved: 'leads', office: 'back' }).navCalls, [],
    'and the same rule in the other direction');
  // 'both' crosses freely — that is what 'both' means.
  assert.deepEqual(runBootRestore({ saved: 'settings', office: 'back' }).navCalls, ['settings']);
});

test('the plan gate still outranks the derived predicate', () => {
  // The predicate is deliberately more permissive than the old list. These
  // three are what stops that mattering.
  assert.deepEqual(runBootRestore({ saved: 'bonuses', office: 'back', tier: 'basic' }).navCalls, [],
    'a Basic agent must not be restored into the Bonus Tracker');
  assert.deepEqual(runBootRestore({ saved: 'bonuses', office: 'back', tier: 'pro' }).navCalls, ['bonuses'],
    'a Pro agent still gets it');
  assert.deepEqual(runBootRestore({ saved: 'agency', office: 'front', tier: 'pro' }).navCalls, [],
    'a non-leader must not be restored into Agency');
  assert.deepEqual(runBootRestore({ saved: 'agency', office: 'front', tier: 'leader' }).navCalls, ['agency'],
    'a leader still gets it');
  // Summary is already the default-active section; re-navving would re-render.
  assert.deepEqual(runBootRestore({ saved: 'summary', office: 'front' }).navCalls, []);
  assert.deepEqual(runBootRestore({ saved: null, office: 'front' }).navCalls, []);
});

test('?tab=phonebook still resolves, and it is what the low-balance email sends', () => {
  const notify = readFileSync(
    join(ROOT, 'supabase/functions/wallet-low-balance-notify/index.ts'), 'utf8');
  const m = notify.match(/app\.html\?tab=([a-z-]+)/);
  assert.ok(m, 'wallet-low-balance-notify must still build an ?tab= deep link');
  assert.equal(m[1], 'phonebook');

  const { navCalls } = runBootRestore({ saved: null, office: 'front', search: `?tab=${m[1]}` });
  assert.deepEqual(navCalls, [m[1]], 'the email link must still land on the Phone Book');

  // An explicit ?tab= still wins over the cached section.
  assert.deepEqual(
    runBootRestore({ saved: 'tracker', office: 'back', search: '?tab=phonebook' }).navCalls,
    ['tracker', 'phonebook'],
    'the ?tab= param must be applied last, so it wins');
  // And a name nothing navigates to is still refused.
  assert.deepEqual(runBootRestore({ saved: null, office: 'front', search: '?tab=nope' }).navCalls, []);
});

// ------------------------------------------------------------
// The two AI screens — the kill-switch-safe path
// ------------------------------------------------------------

const KILL_SWITCH_WHY =
  'sec-voice-campaigns and sec-ai-test exist in the markup whether or not the two kill switches ' +
  'allow them. Naming either one in bootDashboard()\'s restore would therefore show an AI screen ' +
  'to an agent entitled to neither. THE GATE IS THE INJECTION, NOT A LIST.';

test('Voice Campaigns and AI Dialer Test are NOT restorable at boot — their nav items do not exist yet', () => {
  for (const id of ['voice-campaigns', 'ai-test']) {
    assert.ok(!STATIC_NAV_TARGETS.includes(id),
      `${id} must have no static nav item — it is injected behind both kill switches`);
    const { navCalls, pending } = runBootRestore({ saved: id, office: 'front' });
    assert.deepEqual(navCalls, [], `boot must not navigate to ${id}. ${KILL_SWITCH_WHY}`);
    assert.equal(pending, id, 'but the intent is remembered for the gated code to honour');
  }
  // Anything else leaves the flag alone.
  assert.equal(runBootRestore({ saved: 'tracker', office: 'back' }).pending, null);
});

test('the late restore is the ONLY navigation to an AI screen, and it lives inside the double kill switch', () => {
  const init = fnBody('async function aiTestInit()');
  const gate = init.indexOf('if (!(agentOn && globalOn)) return;');
  assert.ok(gate > -1, 'the double kill switch must still be there');
  assert.ok(init.indexOf('_pendingLateRestore') > gate,
    `the late restore must sit BELOW the kill switch. ${KILL_SWITCH_WHY}`);
  // It is also inside the injection block, so it cannot run when the items
  // failed to land.
  const injection = sliceBalanced(init, "getElementById('nav-group-outreach')", 'if (outreachGroup &&');
  assert.ok(injection.includes('const _late = _pendingLateRestore;'),
    'the late restore must be inside the injection block, after the items are in the DOM');
  assert.ok(injection.indexOf('setOffice(document.body.dataset.office') < injection.indexOf('const _late'),
    'office visibility must be re-applied before the restore navigates');

  // And nothing ANYWHERE else navigates off this flag. Every mention of it in
  // app.html, in file order: the declaration, the read + spend inside the gate,
  // nav() clearing it, and boot remembering the intent. Five lines, no sixth —
  // a new one is a new way for an AI screen to be reached.
  const mentions = APP_CODE.split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('_pendingLateRestore'));
  assert.deepEqual(mentions, [
    'let _pendingLateRestore = null;',
    'const _late = _pendingLateRestore;',
    '_pendingLateRestore = null;',                       // spent, inside aiTestInit()
    '_pendingLateRestore = null;',                       // cleared by nav()
    "if (saved === 'voice-campaigns' || saved === 'ai-test') _pendingLateRestore = saved;",
  ], KILL_SWITCH_WHY);
});

test('nav() clears the pending late restore, above every early return', () => {
  const body = fnBody('function nav(id) {');
  assert.match(body, /^function nav\(id\) \{[\s\S]{0,600}?\n {2}_pendingLateRestore = null;/,
    'nav() must clear the flag before the plan gate can return — ANY navigation makes it stale');
  assert.ok(body.indexOf('_pendingLateRestore = null;') < body.indexOf('showUpgradeGate'),
    'a nav() that hit the upgrade gate is still the agent going somewhere else');
});

test('with both switches ON the late restore navigates; with them OFF it is unreachable', () => {
  const withAi = [...STATIC_NAV_TARGETS, 'voice-campaigns', 'ai-test'];

  // Switches ON: aiTestInit() got past the gate, injected the items, and the
  // flag is honoured.
  const vc = runLateRestore({ pending: 'voice-campaigns', office: 'front', navTargets: withAi });
  assert.deepEqual(vc.navCalls, ['voice-campaigns']);
  assert.equal(vc.pending, null, 'the flag is spent, whatever happened next');

  const ai = runLateRestore({ pending: 'ai-test', office: 'front', navTargets: withAi });
  assert.deepEqual(ai.navCalls, ['ai-test']);
  assert.deepEqual(ai.shows, ['ai-test'], 'nav() has no ai-test hook, so the restore must call aiTestOnShow()');

  // Switches OFF: aiTestInit() returned at the gate, so this code never ran and
  // the items were never injected. Modelled both ways — the flag is simply
  // never read, and even if it somehow were, there is no nav item to resolve.
  const off = runLateRestore({ pending: 'voice-campaigns', office: 'front', navTargets: STATIC_NAV_TARGETS });
  assert.deepEqual(off.navCalls, [], `no AI nav item means no restore. ${KILL_SWITCH_WHY}`);

  // The agent clicked something while injection was in flight — nav() cleared it.
  assert.deepEqual(runLateRestore({ pending: null, office: 'front', navTargets: withAi }).navCalls, []);

  // Office guard applies here too: never drag the agent across the toggle.
  assert.deepEqual(
    runLateRestore({ pending: 'voice-campaigns', office: 'back', navTargets: withAi }).navCalls, []);
});
