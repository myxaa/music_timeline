// Service worker — app-shell cache with safe update semantics.
//
// Why this file looks the way it does (read before editing):
//
//   The previous SW was cache-first on EVERYTHING, never claimed clients,
//   and never told the page to reload after a new SW activated. Result:
//   a phone that loaded the app once kept serving the same cached HTML
//   forever, and the only way out was to clear browser data. This rewrite
//   makes the upgrade path automatic by combining four moves:
//
//     1. skipWaiting() on install — the new SW takes over without waiting
//        for every tab to close.
//     2. clients.claim() on activate — the new SW controls existing tabs
//        immediately, firing 'controllerchange' on each one.
//     3. Network-first for navigation requests — a fresh HTML reaches the
//        device on every visit while online; cache is only the offline
//        fallback. So even if assets are stale, the HTML's <script ?v=…>
//        tags carry the new asset version and the browser bypasses the
//        old cached entries.
//     4. The page (app.js) listens for 'controllerchange' and reloads.
//
// To ship a new shell, bump VERSION below AND in app/index.html (the same
// string is used for the cache name + the ?v=… query on shell assets).
// Use scripts/bump_version.py to keep them in lockstep.

const VERSION = "20260523d";
const CACHE = "mt-shell-" + VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./style.css?v=" + VERSION,
  "./i18n.js?v=" + VERSION,
  "./app.js?v=" + VERSION,
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Pre-cache the shell, but don't let one 404 fail the whole install.
    // Anything that didn't make it now will be cached on first fetch.
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Drop every old cache (any name that isn't our current one).
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // ── Navigation HTML: network-first ───────────────────────────────────────
  // Page itself is small. Re-fetching it on every visit while online means
  // version bumps in `?v=…` always reach the browser. Falls back to the
  // cached shell when offline.
  if (req.mode === "navigate" ||
      (sameOrigin && (url.pathname.endsWith("/index.html") || url.pathname.endsWith("/")))) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || caches.match("./index.html") || caches.match("./");
      }
    })());
    return;
  }

  // ── songs.json: network-first (data changes with each verify run) ────────
  if (sameOrigin && url.pathname.endsWith("songs.json")) {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch { return (await caches.match(req)) || Response.error(); }
    })());
    return;
  }

  // ── Everything else: cache-first, populate on miss ───────────────────────
  // Versioned shell assets (?v=…) live forever in cache until VERSION
  // changes and activate() purges the old cache.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh.ok && sameOrigin) {
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return fresh;
    } catch (e) {
      // Offline + uncached → propagate the failure.
      return Response.error();
    }
  })());
});
