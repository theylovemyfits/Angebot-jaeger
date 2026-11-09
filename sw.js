// Offline-Unterstützung für die Handy-App
// Immer zuerst das Netz fragen (damit Updates sofort ankommen), ohne Netz den Speicher nutzen.
const CACHE = 'radar-v2.3.1';
const SHELL = ['./', './index.html', './app.css', './app.js', './lib.js', './stores.js', './manifest.webmanifest',
  './icons/app-192.png', './icons/app-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // GitHub-API nie zwischenspeichern
  const key = url.origin + url.pathname;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key).then(r => r || caches.match(url.origin + url.pathname.replace(/[^/]*$/, '')))
      .then(r => r || new Response('null', { status: 503 })))
  );
});
