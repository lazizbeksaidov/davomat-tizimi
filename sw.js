const CACHE_NAME = 'intizom-v8-fast';
// Precache critical shell assets — available instantly on subsequent loads
const ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim()).then(() => {
      // Notify all open clients to reload so they pick up the fresh HTML immediately
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => { try { c.postMessage({ type: 'SW_UPDATED' }); } catch(e){} });
      });
    })
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;

  // Firebase APIs: network-only (never cache live data)
  if (url.includes('firebaseio.com') || url.includes('googleapis.com') || url.includes('cloudfunctions.net') || url.includes('firebaseapp.com/__/')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // HTML & static assets: STALE-WHILE-REVALIDATE
  // Serve cached version INSTANTLY (fast open on slow devices),
  // then fetch fresh version in background and cache it for next load.
  // Users on slow connections see app immediately; updates arrive on next open.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => cached);
      // Return cached if available (instant), otherwise wait for network
      return cached || fetchPromise;
    })
  );
});

// Listen for skip waiting message from app
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting' || (e.data && e.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});
