// Service worker: i file del gioco sono sempre verificati sul server (no-cache), così dopo un
// aggiornamento non si mescolano file vecchi della cache di Safari con file nuovi.
// Senza rete si usa la copia già scaricata.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const fresh = req.mode === 'navigate'
    ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(new Request(req, { cache: 'no-cache' }));
  event.respondWith(fresh.catch(() => fetch(req)));
});
