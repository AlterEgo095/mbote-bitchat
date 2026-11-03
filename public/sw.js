/**
 * Service worker Mbote Mesh — offline-first (PWA).
 *
 * Stratégie :
 *  - app shell + assets statiques : cache-first (revalidé en arrière-plan)
 *  - navigations (pages) : network-first avec repli cache → l'app s'ouvre
 *    même sans réseau (le « mode courrier » du client gère la queue locale)
 *  - /api publics (GET allowlistés) : network-first strict + stale-if-error —
 *    le réseau fait foi (fraîcheur), le cache « mbote-api-v1 » ne répond que
 *    si le réseau est injoignable
 *  - /api autres (dms, identity, mesh/bridge, seed, follows, /api nu…) :
 *    network-only, jamais cachés (données privées / enveloppes à preuves)
 *  - socket.io (/socket.io, engine.io) : jamais intercepté (temps réel)
 */

/**
 * F-26 (audit Vague 5) : version auto-skipWaiting supprimée — le nouveau SW
 * ATTEND désormais que l'utilisateur ait accepté la mise à jour (toast
 * « Nouvelle version » dans PwaRegister.tsx, qui envoie le message
 * SKIP_WAITING). Fini les rechargements à l'improviste en pleine rédaction.
 * v4 : flux de mise à jour contrôlé + offline.html déjà v3.
 */
const VERSION = "mbote-v4";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
  "/offline.html",
];

// ---------------------------------------------------------------------------
// Cache runtime API (F-25) — stale-if-error sur les GET /api publics.
// « mbote-api-v1 » est volontairement HORS versionnement du shell : il
// persiste entre les versions du SW et n'est purgé que par budget.
// ---------------------------------------------------------------------------

const API_CACHE = "mbote-api-v1";
const API_CACHE_MAX = 60; // budget : 60 entrées max, purge des plus anciennes

// Allowlist stricte des API publics cachables (préfixes de pathname, avec
// frontière de segment). Exclus d'office : /api/dms*, /api/identity,
// /api/mesh/bridge, /api/seed, /api/follows, /api nu — et /api/posts/like
// (POST, exclu de toute façon car non-GET).
const API_ALLOWLIST = ["/api/posts", "/api/channels", "/api/stats", "/api/users"];

function estApiPubliqueGet(url, req) {
  if (req.method !== "GET") return false;
  return API_ALLOWLIST.some(
    (p) => url.pathname === p || url.pathname.startsWith(`${p}/`)
  );
}

// Budgète le cache API après chaque écriture : au-delà de 60 entrées, supprime
// les plus anciennes (cache.keys() est ordonné par insertion → premières clés
// = plus vieilles). Simple et synchrone, sans await.
function limiterCacheApi(cache) {
  return cache
    .keys()
    .then((cles) => {
      const excedent = cles.length - API_CACHE_MAX;
      for (let i = 0; i < excedent; i++) cache.delete(cles[i]);
    })
    .catch(() => undefined);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .catch(() => undefined) // l'app shell se reconstruira à la première visite
    // F-26 : PAS de skipWaiting() automatique — le SW attend l'accord de
    // l'utilisateur (message SKIP_WAITING ci-dessous).
  );
});

// F-26 : activation sur consentement explicite du client (toast + bouton)
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // purge des caches des anciennes versions (mbote-v1-*) SAUF le
            // cache API « mbote-api-v1 » qui persiste (purge par budget seul)
            .filter((k) => k !== API_CACHE && !k.startsWith(VERSION))
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

  // /api publics (GET) : network-first strict + stale-if-error.
  // Réseau OK → réponse servie telle quelle (fraîcheur), seule une 200 est
  // mise en cache (jamais les non-200 ni les opaques). Réseau échoué
  // (TypeError…) → repli sur le cache (clé = URL complète, querystring
  // incluse, sans normalisation), sinon 503 JSON.
  if (estApiPubliqueGet(url, req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.status === 200 && res.type !== "opaque") {
            const copie = res.clone();
            const ecriture = caches
              .open(API_CACHE)
              .then((cacheRuntime) =>
                cacheRuntime.put(req, copie).then(() => limiterCacheApi(cacheRuntime))
              )
              .catch(() => undefined);
            event.waitUntil(ecriture);
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then(
            (enCache) =>
              enCache ??
              new Response(JSON.stringify({ error: "offline", source: "sw-cache-miss" }), {
                status: 503,
                headers: { "Content-Type": "application/json" },
              })
          )
        )
    );
    return;
  }

  // jamais le temps réel ni le reste de l'API (network-only, non caché)
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
          // F-49 : repli sur la page hors-ligne brandée (au lieu du texte nu 503)
          caches
            .match("/offline.html")
            .then((fallback) => fallback ?? new Response("Hors ligne", { status: 503 }))
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
