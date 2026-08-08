// Offline shell. Bump CACHE when you change any of the shell files so old
// copies get evicted.
const CACHE = "itw-shell-v2";

const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./drive.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // Only ever sweep up old *shell* caches. The vehicle photos live in
            // itw-photos-*, and deleting those would strip every image off the
            // device on the next deploy.
            .filter((k) => k.startsWith("itw-shell-") && k !== CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Never intercept Google's sign-in script or the Drive API — those must
  // always hit the network and must not be cached.
  if (new URL(req.url).origin !== self.location.origin) return;

  // Network first, so a deploy shows up as soon as the device is online.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
