const CACHE_NAME = "ani-tracker-shell-v3";
const APP_SHELL = [
  "/manifest.webmanifest",
  "/icons/ani-tracker.svg",
  "/icons/ani-tracker-192.png",
  "/icons/ani-tracker-512.png",
  "/icons/apple-touch-icon.png"
];

/** 缓存构建后的入口、哈希资源和 PWA 基础文件。 */
async function cacheBuiltAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await fetch("/", { cache: "no-cache" });
  const indexHtml = await indexResponse.clone().text();
  const assetUrls = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], self.location.origin + "/"))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => `${url.pathname}${url.search}`);

  await cache.put("/", indexResponse);
  await cache.addAll([...new Set([...APP_SHELL, ...assetUrls])]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheBuiltAppShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    requestUrl.origin !== self.location.origin ||
    requestUrl.pathname.startsWith("/api/")
  ) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/").then((cached) => cached ?? Response.error())));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? Response.error()))
  );
});
