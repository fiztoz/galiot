/* Galiot service worker — static shell caching. S3 traffic goes through /api/ and is never cached. */
/*
 * This file is plain JavaScript, served verbatim from public/. It is NOT
 * transpiled, so TypeScript syntax here is a runtime SyntaxError that kills
 * registration with an opaque "ServiceWorker script evaluation failed".
 * src/deployConfig.test.ts runs `node --check` over public/*.js to catch that.
 */


const CACHE_NAME = 'galiot-v1';
const ASSETS_CACHE_NAME = 'galiot-assets-v1';

/*
 * Hashed assets never change, but every deploy adds a new set (~18 MB with
 * PGlite). Entries are stamped when stored and pruned after this age; one
 * still in use is simply fetched again on its next request.
 */
const ASSET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = 'x-galiot-cached-at';

function pruneAssets() {
  return caches.open(ASSETS_CACHE_NAME).then((cache) =>
    cache.keys().then((requests) =>
      Promise.all(requests.map((request) =>
        cache.match(request).then((response) => {
          const cachedAt = Number(response && response.headers.get(CACHED_AT_HEADER));
          if (!cachedAt || Date.now() - cachedAt > ASSET_MAX_AGE_MS) return cache.delete(request);
          return false;
        })
      ))
    )
  );
}

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
    }).then(pruneAssets)
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

  // 1. App Assets (/assets/*) -> Cache First, fallback to Network
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            const headers = new Headers(copy.headers);
            headers.set(CACHED_AT_HEADER, String(Date.now()));
            // The body read back is already decoded; the wire encoding and
            // length no longer describe it.
            headers.delete('content-encoding');
            headers.delete('content-length');
            event.waitUntil(copy.blob().then((body) =>
              caches.open(ASSETS_CACHE_NAME).then((cache) =>
                cache.put(event.request, new Response(body, { status: copy.status, statusText: copy.statusText, headers }))
              )
            ));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 2. Navigation/App Shell -> Network First, fallback to Cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Only a good shell becomes the offline copy: an error page seen
          // during a rollout must not replace it. Keyed by '/' alone so query
          // strings (share targets) are never stored.
          if (response.ok && url.pathname === '/') {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('/', responseToCache);
            });
            event.waitUntil(pruneAssets());
          }
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
