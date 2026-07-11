const CACHE_NAME = 'pq-character-lab-v1';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './data/character.json',
  './js/character.js',
  './js/renderer.js',
  './js/stateManager.js',
  './assets/states/idle.png',
  './assets/states/happy.png',
  './assets/states/sad.png',
  './assets/states/win.png',
  './assets/states/lose.png',
  './assets/outfits/head/none.png',
  './assets/outfits/head/cap_blue.png',
  './assets/outfits/head/crown_gold.png',
  './assets/outfits/head/halo.png',
  './assets/outfits/body/none.png',
  './assets/outfits/body/hoodie_sky.png',
  './assets/outfits/body/jacket_purple.png',
  './assets/outfits/body/badge_star.png',
  './assets/outfits/shoes/none.png',
  './assets/outfits/shoes/sneakers_blue.png',
  './assets/outfits/shoes/boots_black.png',
  './assets/outfits/shoes/gold_steps.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
