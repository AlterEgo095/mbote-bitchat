/**
 * Service worker Mbote Mesh — offline-first (PWA).
 *
 * Stratégie :
 *  - app shell + assets statiques : cache-first (revalidé en arrière-plan)
 *  - navigations (pages) : network-first avec repli cache → l'app s'ouvre
 *    même sans réseau (le « mode courrier » du client gère la queue locale)
 *  - /api/* : network-only (les données sociales sont gérées par le client,
 *    qui met en file locale — pas de cache opaque côté SW)
 *  - socket.io (/socket.io, engine.io) : jamais intercepté (temps réel)
 */

const VERSION = "mbote-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .catch(() => undefined) // l'app shell se reconstruira à la première visite
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(VERSION))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // même origine uniquement
  if (url.origin !== self.location.origin) return;

  // jamais le temps réel ni l'API
  if (
    url.pathname.startsWith("/socket.io") ||
    url.pathname.includes("engine.io") ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // navigations : network-first, repli sur l'app shell en cache
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy)).catch(() => undefined);
          return res;
        })
        .catch(() =>
          caches.match("/").then((cached) => cached ?? new Response("Hors ligne", { status: 503 }))
        )
    );
    return;
  }

  // assets : cache-first avec revalidation en arrière-plan
  if (req.method === "GET") {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok && (url.pathname.startsWith("/_next/") || url.pathname.startsWith("/icons/"))) {
              const copy = res.clone();
              caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(() => cached);
        return cached ?? network;
      })
    );
  }
});
