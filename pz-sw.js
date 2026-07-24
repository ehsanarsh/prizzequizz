/* PrizzeQuizz push service worker.
   Deploy this file next to the game's index.html (web root), so it's reachable
   at /pz-sw.js. It shows push notifications even when the app/tab is closed and
   opens the right screen on tap. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { try { data = { title: 'PrizzeQuizz', body: event.data ? event.data.text() : '' }; } catch (_) {} }
  var title = data.title || 'PrizzeQuizz';
  var url = (data.data && data.data.url) || data.url || '/';
  var options = {
    body: data.body || '',
    data: { url: url, id: data.id || null },
    dir: 'rtl',
    lang: 'fa',
    tag: data.id ? String(data.id) : undefined,
    renotify: true,
    vibrate: [60, 40, 60],
    badge: undefined
  };
  if (data.image) options.image = data.image;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) { try { c.postMessage({ type: 'pz-open', url: url }); } catch (e) {} return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
