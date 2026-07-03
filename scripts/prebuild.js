const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');

fs.mkdirSync(www, { recursive: true });

// Marketing site pages (kept reachable — app.html links out to these) plus
// the CRM dashboard itself. index.html here is the marketing landing page.
const pages = [
  'index.html',
  'app.html',
  'features.html',
  'how-it-works.html',
  'pricing.html',
  'support.html',
  'privacy-policy.html',
  'terms-of-service.html',
  'power-dialer.html',
];

for (const file of [...pages, 'manifest.json', 'sw.js', 'styles.css']) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(www, file));
}

fs.cpSync(path.join(root, 'assets'), path.join(www, 'assets'), { recursive: true });

// Native app entry point: open straight into the CRM dashboard (app.html),
// not the marketing landing page. app.html is also kept at its own path
// since its nav links reference it directly.
fs.copyFileSync(path.join(root, 'app.html'), path.join(www, 'index.html'));
