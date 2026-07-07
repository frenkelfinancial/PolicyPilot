#!/usr/bin/env node
/*
 * Pre-push guard for the inline-JS HTML apps.
 *
 * The app is one large inline <script> in app.html with no build step, so a
 * single JS mistake — a syntax slip, or a variable referenced from the wrong
 * scope (exactly what silently broke the softphone dialer) — ships to
 * production undetected. This catches both classes before they go live:
 *
 *   1. Syntax errors        (node --check)
 *   2. Undefined variables  (ESLint no-undef) + a few other high-signal rules
 *
 * It extracts the inline JS while preserving original line numbers, so every
 * finding points at the real app.html:LINE you can click.
 *
 * Usage:  node scripts/check-app.mjs [file.html ...]   (defaults to app.html)
 * Exit 0 = clean, exit 1 = problems found.
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Linter } from 'eslint';
import globals from 'globals';

const args = process.argv.slice(2);
const UPDATE_BASELINE = args.includes('--update-baseline');
const FILES = args.filter(a => !a.startsWith('--'));
if (FILES.length === 0) FILES.push('app.html');

// Baseline = the set of pre-existing findings we knowingly tolerate (legacy
// dead code, intentional implicit globals). The hook fails only on findings
// NOT in the baseline — i.e. bugs a new change introduced. Regenerate after a
// deliberate cleanup with:  node scripts/check-app.mjs --update-baseline
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'check-app.baseline.json');
const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')))
  : new Set();
// A fingerprint deliberately excludes the line number so unrelated edits that
// shift line numbers don't turn a known finding into a "new" one.
const fingerprint = (file, m) => `${file}|${m.ruleId || 'syntax'}|${m.message}`;
const newlySeen = [];

// Globals provided at runtime by the browser and the CDN <script> tags, so
// referencing them is legitimate (not an undefined-variable bug). Add here if
// you pull in a new library via a <script src>.
const RUNTIME_GLOBALS = {
  ...globals.browser,
  ...globals.serviceworker,
  Stripe: 'readonly',
  XLSX: 'readonly',
  supabase: 'readonly',
  Capacitor: 'readonly',
  google: 'readonly',
  gapi: 'readonly',
  L: 'readonly',
  dayjs: 'readonly',
  Telnyx: 'readonly',
  firebase: 'readonly',
  softphone: 'writable',
};

const LINT_CONFIG = {
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'script',
    globals: RUNTIME_GLOBALS,
  },
  rules: {
    'no-undef': 'error',        // the softphone-breaking class of bug
    'no-const-assign': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-func-assign': 'error',
    'no-class-assign': 'error',
    'no-self-assign': 'error',
    'no-unreachable': 'warn',
    'use-isnan': 'error',
  },
};

/*
 * Replace every non-inline-script line with an empty line, keeping inline
 * <script> (no src=) contents in place. Output has the same line count as the
 * source, so reported line numbers match the original file exactly.
 */
function maskToInlineJS(html) {
  const lines = html.split('\n');
  const out = new Array(lines.length).fill('');
  let inScript = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inScript) {
      const m = line.match(/<script(\s[^>]*)?>/i);
      if (!m) continue;
      if (/\bsrc\s*=/i.test(m[1] || '')) continue; // external script — skip
      const after = line.slice(m.index + m[0].length);
      const closeIdx = after.search(/<\/script>/i);
      if (closeIdx >= 0) {
        out[i] = after.slice(0, closeIdx);        // opens and closes same line
      } else {
        out[i] = after;
        inScript = true;
      }
    } else {
      const c = line.search(/<\/script>/i);
      if (c >= 0) { out[i] = line.slice(0, c); inScript = false; }
      else { out[i] = line; }
    }
  }
  return out.join('\n');
}

const linter = new Linter();
let hadError = false;
const tmp = mkdtempSync(join(tmpdir(), 'checkapp-'));

for (const file of FILES) {
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch {
    console.error(`✗ ${file}: cannot read`);
    hadError = true;
    continue;
  }
  const js = maskToInlineJS(html);
  const tmpFile = join(tmp, file.replace(/[\/\\]/g, '_') + '.js');
  writeFileSync(tmpFile, js);

  const problems = [];

  // 1) Syntax check via Node's own parser. Syntax errors are never baselined —
  //    a broken file must always block.
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  } catch (e) {
    const raw = (e.stderr ? e.stderr.toString() : e.message) || '';
    const remapped = raw.split('\n')
      .filter(l => l.includes(tmpFile) || /SyntaxError/.test(l))
      .map(l => l.replace(tmpFile, file))
      .join(' ')
      .trim();
    problems.push({ line: 0, col: 0, severity: 2, ruleId: null, message: `SYNTAX ERROR: ${remapped}`, syntax: true });
  }

  // 2) Undefined variables + high-signal rules via ESLint.
  for (const m of linter.verify(js, LINT_CONFIG)) {
    problems.push({ line: m.line || 0, col: m.column || 0, severity: m.severity, ruleId: m.ruleId, message: m.message });
  }

  // Classify each problem against the baseline.
  const fresh = [];   // not in baseline (new — these block)
  const known = [];   // in baseline (tolerated)
  for (const p of problems) {
    p.fp = fingerprint(file, p);
    if (p.syntax || !baseline.has(p.fp)) fresh.push(p);
    else known.push(p);
    if (UPDATE_BASELINE && !p.syntax) newlySeen.push(p.fp);
  }

  const freshErrors = fresh.filter(p => p.severity === 2);
  if (freshErrors.length) hadError = true;

  const label = freshErrors.length ? '✗' : (fresh.length ? '⚠' : '✓');
  console.log(`${label} ${file}: ${freshErrors.length} new error(s), ${fresh.length - freshErrors.length} new warning(s), ${known.length} known (baselined)`);
  for (const p of fresh.sort((a, b) => a.line - b.line)) {
    const tag = p.severity === 2 ? 'ERROR' : 'warn ';
    const rule = p.ruleId ? `  (${p.ruleId})` : '';
    console.log(`  ${tag} ${file}:${p.line}:${p.col}  ${p.message}${rule}`);
  }
}

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_PATH, JSON.stringify([...new Set(newlySeen)].sort(), null, 2) + '\n');
  console.log(`\nBaseline updated: ${BASELINE_PATH} (${new Set(newlySeen).size} entries).`);
  process.exit(0);
}

if (hadError) {
  console.error('\n✗ New problems introduced — fix them before pushing.');
  console.error('  (If a finding is intentional, run: node scripts/check-app.mjs --update-baseline)');
  process.exit(1);
}
console.log('\nAll checks passed — no new problems.');
