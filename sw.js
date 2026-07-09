const CACHE = 'policypilot-v2';
const PRECACHE = [
  '/index.html',
  '/manifest.json',
  '/assets/logos/policypilot-logo.jpg',
  'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&family=Sora:wght@700;800&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Skip cross-origin requests to Supabase, SignalWire, CDN — always go network for those
  const url = new URL(e.request.url);
  const passThrough =
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('signalwire.com') ||
    url.hostname.includes('sheetjs.com') ||
    url.hostname.includes('fonts.gstatic.com');

  if (passThrough || e.request.method !== 'GET') return;

  // Network-first for HTML (always get latest app), cache-first for everything else
  if (e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request)
        .then(res => { caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }))
    );
  }
});
