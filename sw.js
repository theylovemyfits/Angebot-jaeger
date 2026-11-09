// Offline-Unterstützung für die Handy-App
const CACHE = 'radar-v2.1.0';
const SHELL = ['./', './index.html', './app.css', './app.js', './lib.js', './stores.js', './manifest.webmanifest',
  './icons/app-192.png', './icons/app-512.png', './icons/apple-touch-icon.png'];
const DATA = ['data.json', 'history.json', 'catalog.json', 'watchlist.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // GitHub-API nie zwischenspeichern
  const isData = DATA.some(d => url.pathname.endsWith('/' + d));
  if (isData) {
    // Daten: erst Netz, ohne Netz die zuletzt geladene Version
    const key = url.origin + url.pathname;
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key).then(r => r || new Response('null', { status: 503 }))));
    return;
  }
  // App-Dateien: sofort aus dem Speicher, im Hintergrund aktualisieren
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(cached => {
    const net = fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => cached);
    return cached || net;
  }));
});
