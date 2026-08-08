/* Service worker — just enough to make the app launch offline.
   The library itself is server-side, so API responses are never cached; only
   the shell and the downloaded thumbnails are. */

'use strict';

const SHELL_CACHE = 'bookmarks-shell-v1';
const MEDIA_CACHE = 'bookmarks-media-v1';

const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== SHELL_CACHE && key !== MEDIA_CACHE)
            .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve a stale library.
  if (url.pathname.startsWith('/api/') || url.pathname === '/share') return;

  // Thumbnails are content-addressed by bookmark id — cache them hard.
  if (url.pathname.startsWith('/media/')) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async cache => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Shell: network first so updates land, cache as the offline fallback.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('/')))
  );
});
