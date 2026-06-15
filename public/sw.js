/*
 * Intentionally minimal service worker.
 *
 * HARD CONSTRAINT: this service worker MUST NOT cache or intercept any
 * requests. It registers NO `fetch` handler, so every network request —
 * including ranged media requests for native source audio and recorded audio
 * playback — goes straight to the network untouched. This is what keeps audio
 * playback working in iPhone Safari (acceptance test #11) while still allowing
 * the app to be "installed" to the home screen.
 *
 * If you ever add offline caching, do it deliberately and EXCLUDE all of:
 *   - /api/*           (dynamic backend calls)
 *   - /api/audio/*     (native source audio — served with HTTP Range requests)
 *   - any request with a `Range` header (never cache partial/range responses)
 * Caching ranged media responses is exactly what breaks Safari audio playback.
 */

self.addEventListener("install", () => {
  // Activate immediately; nothing to pre-cache.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control and proactively clear any caches a previous version may have
  // created, guaranteeing a clean, non-intercepting worker.
  event.waitUntil(
    (async () => {
      if (self.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      await self.clients.claim();
    })(),
  );
});

// NOTE: deliberately NO "fetch" event listener.
