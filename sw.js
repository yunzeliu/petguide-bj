// Service worker for offline-first browsing
const VERSION = 'v1.8.0';
const CORE_CACHE = `petguide-core-${VERSION}`;
const DATA_CACHE = `petguide-data-${VERSION}`;
const CDN_CACHE  = `petguide-cdn-${VERSION}`;

// Core shell files (precached on install)
const CORE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './manifest.json',
  './assets/logo.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

// CDN assets we want to cache
const CDN_PREFIXES = [
  'https://cdn.jsdelivr.net/',
  'https://unpkg.com/leaflet@',
  'https://basemaps.cartocdn.com/',  // tile cache (best-effort)
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CORE_CACHE).then(c => c.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter(n => n.startsWith('petguide-') && !n.endsWith(VERSION))
             .map(n => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// Strategy:
//   /data/*       network-first, fall back to cache (so fresh deploys win)
//   /css /js core cache-first, network update in background (stale-while-revalidate)
//   CDN          cache-first
//   gemini API   never cache, network only
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept Gemini calls or any non-http(s) scheme
  if (url.host.includes('generativelanguage.googleapis.com')) return;
  if (url.protocol === 'chrome-extension:') return;

  // CDN cache-first
  if (CDN_PREFIXES.some(p => req.url.startsWith(p))) {
    e.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // Same-origin handling
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/data/')) {
      e.respondWith(networkFirst(req, DATA_CACHE));
    } else {
      e.respondWith(staleWhileRevalidate(req, CORE_CACHE));
    }
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return hit || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    return hit || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetchPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fetchPromise;
}
