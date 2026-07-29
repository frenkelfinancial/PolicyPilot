#!/usr/bin/env node
// Local preview server — serves the repo working tree exactly as GitHub Pages
// serves the deployed root, so you can eyeball changes to app.html (and every
// other page) in a real browser BEFORE pushing. Zero dependencies on purpose,
// matching the rest of this repo's tooling; it is dev-only and never shipped.
//
//   npm run preview            → http://localhost:8080/app.html
//   PORT=3000 npm run preview  → pick a different port
//   npm run preview -- --no-open   → don't auto-open the browser
//
// It serves from the current working directory, sets no-cache headers (so a
// refresh always shows your latest edit), and never lists or serves anything
// above the repo root.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8080;
const OPEN = !process.argv.includes('--no-open');
// Land on the app itself — it's the page you're almost always previewing.
const DEFAULT_PAGE = 'app.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.pdf':  'application/pdf',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    ...headers,
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, `http://localhost`).pathname);
    if (pathname === '/') pathname = '/' + DEFAULT_PAGE;

    // Resolve within ROOT and refuse anything that escapes it.
    const filePath = normalize(join(ROOT, pathname));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      return send(res, 403, 'Forbidden');
    }

    let target = filePath;
    let info;
    try {
      info = await stat(target);
      if (info.isDirectory()) {
        target = join(target, 'index.html');
        info = await stat(target);
      }
    } catch {
      return send(res, 404,
        `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px">` +
        `<h1>404</h1><p>Not found: <code>${pathname}</code></p>` +
        `<p><a href="/${DEFAULT_PAGE}">→ ${DEFAULT_PAGE}</a></p>`,
        { 'Content-Type': 'text/html; charset=utf-8' });
    }

    const body = await readFile(target);
    send(res, 200, body, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
  } catch (err) {
    send(res, 500, `Server error: ${err.message}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try:  PORT=${PORT + 1} npm run preview\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/${DEFAULT_PAGE}`;
  console.log(`\n  PolicyPilot preview  →  ${url}`);
  console.log(`  Serving:             ${ROOT}`);
  console.log(`  Edit a file, then just refresh the browser. Ctrl+C to stop.\n`);
  if (OPEN) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* no browser, no problem */ }
  }
});
