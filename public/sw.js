// Minimal PWA service worker: enables "Add to Home Screen" / installability
// and a best-effort offline fallback. Deliberately network-first (never
// stale-serves-while-online) since prices and catalog come from a live
// Google Sheet — correctness matters more here than offline completeness.
const CACHE_VERSION = "priceedge-v1";
const APP_SHELL = [
  "/",
  "/brands.html",
  "/account.html",
  "/css/styles.css",
  "/js/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
