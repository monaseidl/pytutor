// ─────────────────────────────────────────────────────────────
// PyTutor Service Worker
//
// Nach jedem App-Update: CACHE_NAME hochzählen  (v1 → v2 → v3 …)
// Der alte Cache wird dann beim nächsten Start automatisch
// gelöscht und alle Dateien frisch vom Server geladen.
// ─────────────────────────────────────────────────────────────
const CACHE_NAME = 'pytutor-v3'; // <── nur diese Zeile ändern!

const ASSETS = [
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './exercises/lab01.json',
  './exercises/lab03b.json'
];

// install: alle Dateien in den Cache laden
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting(); // neuen SW sofort aktivieren ohne Seite neu laden
});

// activate: alle alten Caches (andere Versionsnamen) löschen
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME) // alles außer aktuellem Cache
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim(); // bestehende Tabs sofort übernehmen
});

// fetch: nur Same-Origin cachen, externe API-Calls direkt durchlassen
self.addEventListener('fetch', event => {
  if (event.request.url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
  }
});
