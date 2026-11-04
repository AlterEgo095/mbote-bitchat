/**
 * Mbote Relay Service — hub temps réel (socket.io) — déploiement Docker/VPS
 *
 * Deux ports :
 *  - 3030 (public, via Caddy XTransformPort) : connexions navigateurs socket.io
 *   Rooms :
 *      · "feed"            → tout le fil public
 *      · "channel:<gh>"    → un canal géohash précis
 *      · "dm:<pubkey>"     → boîte à lettres privée d'une identité (F-08 :
 *        ouverte UNIQUEMENT avec une preuve signée courte durée)
 *  - 3031 (interne uniquement) : POST /emit depuis les routes API Next.js
 *    pour diffuser un événement sans jamais bloquer la requête HTTP principale.
 *
 * Événements diffusés :
 *  post:new | post:like | dm:new | identity:new | presence:update
 *
 * NOTE D'ARCHITECTURE (Vague 6) : la logique du hub vit dans `hub.ts`
 * (runtime-agnostique) — le mode dev/sandbox l'embarque dans le processus
 * Next.js (src/instrumentation.ts) au lieu de lancer ce conteneur. Ce fichier
 * reste l'entrée de production (Docker) — 100 % API node:http, plus de
 * dépendance Bun.serve.
 *
 * F-08 : CORS restreint (aucune origine croisée par défaut —
 * `RELAY_ALLOWED_ORIGIN` pour ouvrir explicitement) + dm:<pubkey> exige une
 * preuve de possession ECDSA P-256.
 * F-51 : token /emit (RELAY_EMIT_TOKEN défini = exigé, header x-emit-token) +
 * bind explicite de l'endpoint interne (RELAY_EMIT_HOST, défaut 0.0.0.0 =
 * réseau Docker interne ; 127.0.0.1 sur un hôte unique).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createRelayHub } from "./hub";

const RELAY_PORT = Number(process.env.RELAY_PORT ?? 3030); // public (navigateurs)
const EMIT_PORT = Number(process.env.EMIT_PORT ?? 3031); // interne (routes API)
// F-51 : token optionnel pour /emit — RELAY_EMIT_TOKEN défini = exigé (header
// x-emit-token) ; vide (défaut sandbox) = contrôle désactivé (réseau Docker interne).
const EMIT_TOKEN = process.env.RELAY_EMIT_TOKEN ?? "";
// F-51 (Vague 6) : bind explicite de l'endpoint interne. Défaut 0.0.0.0 =
// requis dans le réseau Docker compose (mbote → relay). Sur un hôte unique
// (sandbox), démarrer avec RELAY_EMIT_HOST=127.0.0.1 pour que /emit ne soit
// jamais exposé sur les interfaces externes.
const EMIT_HOST = process.env.RELAY_EMIT_HOST ?? "0.0.0.0";

/** F-08 : origines croisées autorisées — vide = aucune (même origine via Caddy). */
const ALLOWED_ORIGINS = (process.env.RELAY_ALLOWED_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ───────────────────────── serveur socket.io public ─────────────────────────

const httpServer = createServer();
const hub = createRelayHub(httpServer, { allowedOrigins: ALLOWED_ORIGINS });
const { io } = hub;

httpServer.listen(RELAY_PORT, () => {
  console.log(`[relay] socket.io hub démarré sur :${RELAY_PORT} (path=/)`);
  console.log(
    `[relay] CORS : ${ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(", ") : "aucune origine croisée (même origine via Caddy)"}`
  );
});

// ---------- endpoint interne d'émission (routes API Next.js) ----------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("payload trop grand"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function emitEndpoint(req: IncomingMessage, res: ServerResponse): void {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (EMIT_TOKEN && req.headers["x-emit-token"] !== EMIT_TOKEN) {
    send(401, { error: "token requis" });
    return;
  }

  readBody(req)
    .then((raw) => JSON.parse(raw) as { event?: unknown; payload?: unknown; rooms?: unknown })
    .then((body) => {
      const { event, payload, rooms } = body ?? ({} as typeof body);
      if (!event || typeof event !== "string") {
        send(400, { error: "event requis" });
        return;
      }
      const safeRooms = Array.isArray(rooms)
        ? rooms.filter(
            (r): r is string => typeof r === "string" && r.length > 0 && r.length < 64
          )
        : undefined;
      hub.emitEvent(event, payload, safeRooms);
      send(200, { ok: true });
    })
    .catch(() => send(400, { error: "JSON invalide" }));
}

const emitServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(hub.health()));
    return;
  }

  if (req.method === "POST" && url.pathname === "/emit") {
    emitEndpoint(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

emitServer.listen(EMIT_PORT, EMIT_HOST, () => {
  console.log(
    `[relay] endpoint interne d'émission sur :${EMIT_PORT} (/emit, /health) — bind ${EMIT_HOST}`
  );
  if (!EMIT_TOKEN) {
    console.warn(
      "[relay] ⚠️ RELAY_EMIT_TOKEN vide : /emit SANS authentification (acceptable réseau Docker interne uniquement — définir le token en production, F-51)"
    );
  }
});

// ---------- arrêt propre ----------

function shutdown(): void {
  console.log("[relay] arrêt…");
  io.close();
  httpServer.close(() => process.exit(0));
  emitServer.close();
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGTERM", () => {
  console.log("[relay] SIGTERM — arrêt…");
  shutdown();
});

process.on("SIGINT", shutdown);
