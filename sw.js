/* Nova service worker — offline app shell + graceful network handling.
   API calls are never cached; the app queues them while offline. */
const CACHE = "nova-v32";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./bgfx.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/nova.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch POST (AI API calls)

  const url = new URL(req.url);

  // AI providers: network only; a failed fetch surfaces as "offline" in the app.
  if (url.hostname.includes("openai.com") || url.hostname.includes("openrouter.ai") ||
      url.hostname.includes("googleapis.com") || url.hostname.includes("anthropic.com") ||
      url.hostname.includes("tokenharbor.ai") || url.hostname.includes("api.b.ai") ||
      url.hostname.includes("freebuff.page") || url.hostname.includes("pollinations")) {
    return;
  }

  // Same-origin: network-first (so updates arrive immediately),
  // falling back to the cached copy when offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: req.mode === "navigate" })
            .then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
        )
    );
  }
});
