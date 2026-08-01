/* KILL SWITCH for the old PWA service worker.
 *
 * Deploy this AS /var/www/prizequiz/sw.js — it must sit at exactly the path the
 * dead worker was registered from, because that is the only URL a browser will
 * check for an update.
 *
 * The worker it replaces was cache-first with no expiry:
 *
 *     event.respondWith(caches.match(req).then((cached) => cached || fetch(req)))
 *
 * It had cached '/' and '/index.html' from the PWA build. Once those assets were
 * removed from the server the cached HTML still pointed at them, so every visit
 * rendered a page whose scripts 404 — a white screen that never finishes. No
 * amount of redeploying the real game fixes that, because the request never
 * reaches the server.
 *
 * This replacement has NO fetch handler, so nothing is intercepted. It takes
 * control, deletes every cache the origin ever made, unregisters itself, and
 * reloads any open tab so the visitor lands on the live page. After that first
 * visit the browser has no service worker at this scope at all. */

self.addEventListener('install', function () {
  // Do not wait for the dead worker's clients to close.
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) { /* a browser that denies cache access has nothing to clear */ }

    try { await self.clients.claim(); } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}

    // Send every open tab back to the network. Without this the visitor keeps
    // staring at the broken page until they reload by hand.
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try { await client.navigate(client.url); } catch (e) {}
      }
    } catch (e) {}
  })());
});

/* Deliberately no 'fetch' listener. A service worker without one is transparent:
 * the browser goes straight to the network for everything. */
