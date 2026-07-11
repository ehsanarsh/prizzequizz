const CACHE_NAME = 'prizzequizz-pwa-v2';
const ASSETS = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

self.addEventListener('push', (event) => {
  let payload = { title: 'PrizzeQuizz', body: 'پیام جدید داری.', data: { url: '/' } };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {}
  event.waitUntil(self.registration.showNotification(payload.title || 'PrizzeQuizz', {
    body: payload.body || '',
    icon: '/manifest.webmanifest',
    badge: '/manifest.webmanifest',
    data: payload.data || {},
    tag: payload.id || `pq-${Date.now()}`,
    renotify: false
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) {
        client.postMessage({ type: 'notification_click', url: targetUrl });
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  }));
});
