/* Galiot service worker — static shell caching; S3 traffic is never cached. */
/*
 * This file is plain JavaScript, served verbatim from public/. It is NOT
 * transpiled, so TypeScript syntax here is a runtime SyntaxError that kills
 * registration with an opaque "ServiceWorker script evaluation failed".
 * src/deployConfig.test.ts runs `node --check` over public/*.js to catch that.
 */


const CACHE_NAME = 'galiot-v1';
const ASSETS_CACHE_NAME = 'galiot-assets-v1';

const CLOUD_URL_PATTERNS = [
  /^https:\/\/[^/]+\.amazonaws\.com/,
  /^https:\/\/[^/]+\.r2\.cloudflarestorage\.com/,
  /^https:\/\/[^/]+\.digitaloceanspaces\.com/
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Precache the app shell
      return cache.addAll(['/']);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('galiot-') && name !== CACHE_NAME && name !== ASSETS_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 0. API and non-GET -> Network Only, never cached. Session and share-grant
  //    responses must not be stored by the service worker.
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // 1. Cloud Storage Requests -> Network Only
  if (CLOUD_URL_PATTERNS.some((pattern) => pattern.test(url.href))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. App Assets (/assets/*) -> Cache First, fallback to Network
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(ASSETS_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 3. Navigation/App Shell -> Network First, fallback to Cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
          return response;
        })
        .catch(() => {
          return caches.match('/');
        })
    );
    return;
  }

  // Default: Network First
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
