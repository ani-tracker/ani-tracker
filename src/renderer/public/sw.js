const CACHE_NAME = "ani-remote-pwa-v1";
const APP_SHELL = ["./", "./manifest.webmanifest", "./icons/ani-tracker-32.png", "./icons/apple-touch-icon.png"];

/** 安装时缓存远程页面壳，网络中断后仍可显示基础界面。 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

/** 激活时清理旧版本静态缓存并立即接管页面。 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

/** 页面导航优先联网，失败时回退到已缓存的远程页面壳。 */
async function loadNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request) ?? await caches.match("./");
    if (cached) return cached;
    throw error;
  }
}

/** 哈希静态资源优先读取缓存，首次请求成功后写入当前版本缓存。 */
async function loadStaticAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

/** 仅接管同源页面和静态资源，业务接口与媒体流始终直连桌面端。 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(loadNavigation(request));
    return;
  }

  const staticAsset = url.pathname.startsWith("/assets/")
    || url.pathname.startsWith("/icons/")
    || url.pathname === "/manifest.webmanifest";
  if (staticAsset) {
    event.respondWith(loadStaticAsset(request));
  }
});
