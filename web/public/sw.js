/* Orbit service worker (hand-written, no workbox). Bump VERSION to invalidate caches. */
const VERSION = "v2";
// Must match ICON_VERSION in lib/icons.ts (cache-busting query on the PWA icons).
const ICON_VERSION = "2";
const SHELL_CACHE = `orbit-shell-${VERSION}`;
const STATIC_CACHE = `orbit-static-${VERSION}`;
const PAGES_CACHE = `orbit-pages-${VERSION}`;
const API_CACHE = `orbit-api-${VERSION}`;
const ALL_CACHES = [SHELL_CACHE, STATIC_CACHE, PAGES_CACHE, API_CACHE];

const ICONS = [
  `/icons/icon-192.png?v=${ICON_VERSION}`,
  `/icons/icon-512.png?v=${ICON_VERSION}`,
  `/icons/icon-maskable-512.png?v=${ICON_VERSION}`,
  "/icon.svg",
  "/favicon.ico",
  "/apple-icon.png",
];
const PRECACHE = ["/", "/offline", "/manifest.webmanifest", ...ICONS];
// Icons and the manifest are fetched network-first so a new icon replaces the old one at once;
// the cached copy (matched without the query string) is only used offline.
const ICON_PATHS = new Set(["/manifest.webmanifest", ...ICONS.map((u) => u.split("?")[0])]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        // Individual adds so one failing URL does not abort the install.
        Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {}))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("orbit-") && !ALL_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function withCacheHeader(response) {
  const headers = new Headers(response.headers);
  headers.set("x-orbit-from-cache", "1");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function networkFirst(request, cacheName, { markCached = false, fallback, ignoreSearch = false } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch });
    if (cached) return markCached ? withCacheHeader(cached) : cached;
    if (fallback) {
      const fb = await fallback();
      if (fb) return fb;
    }
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      networkFirst(request, API_CACHE, { markCached: true }).catch(
        () =>
          new Response(JSON.stringify({ error: "offline" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, PAGES_CACHE, {
        fallback: async () => (await caches.match("/offline")) || (await caches.match("/")),
      }),
    );
    return;
  }

  if (ICON_PATHS.has(url.pathname)) {
    event.respondWith(networkFirst(request, SHELL_CACHE, { ignoreSearch: true }));
  }
});
