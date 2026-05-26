const CACHE_NAME = "overboard-v1";
const SHELL_ASSETS = ["/"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Skip non-GET, API routes, and EventSource streams
  if (
    e.request.method !== "GET" ||
    url.pathname.startsWith("/api/") ||
    e.request.headers.get("accept")?.includes("text/event-stream")
  ) {
    return;
  }

  // Static assets (/_next/static): cache-first
  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(
      caches.match(e.request).then(
        (cached) => cached || fetch(e.request).then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          return resp;
        }),
      ),
    );
    return;
  }

  // Everything else (pages, _next/data): network-first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        return resp;
      })
      .catch(() => caches.match(e.request)),
  );
});
