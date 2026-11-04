/**
 * Hub temps réel EMBARQUÉ (mode dev/sandbox uniquement)
 *
 * Vague 6 — dette opérationnelle : en sandbox, un mini-service séparé doit
 * être lancé et maintenir en vie par un superviseur externe ; le reaper de la
 * plateforme tue tout processus orphelin, ce qui rendait le relay instable.
 * Solution : en dev, le hub tourne DANS le processus Next.js (déjà supervisé)
 * via src/instrumentation.ts — un processus de moins, zéro duplication
 * (même cœur `mini-services/relay-service/hub.ts` qu'en production Docker).
 *
 * F-51 durci en mode embarqué :
 *  - les DEUX serveurs (3030 public, 3031 interne) écoutent sur 127.0.0.1 ;
 *  - /emit exige un secret ÉPHMÈRE généré au démarrage du processus et
 *    partagé in-process via globalThis (`relay-notify.ts` le lit) — une
 *    requête proxifiée depuis l'extérieur (ex. gateway ?XTransformPort=3031)
 *    obtient 401 même si le bind loopback était contourné.
 *
 * En production (NODE_ENV=production) ce module n'est PAS chargé : le hub
 * tourne dans son conteneur dédié (mini-services/relay-service).
 */

import { createServer, type IncomingMessage } from "http";
import { randomUUID } from "crypto";
import { createRelayHub } from "../../../mini-services/relay-service/hub";

/** secret /emit partagé in-process (jamais exposé hors du processus) */
declare global {
  var __MBOTE_EMIT_TOKEN: string | undefined;
}

const RELAY_PORT = 3030; // public navigateurs (via Caddy ?XTransformPort=3030)
const EMIT_PORT = 3031; // interne routes API → notifications
const BIND = "127.0.0.1"; // F-51 : loopback only en mode embarqué

let started = false;

export function startEmbeddedRelay(): void {
  if (started) return;
  started = true;

  const secret = randomUUID();
  globalThis.__MBOTE_EMIT_TOKEN = secret;

  const ALLOWED_ORIGINS = (process.env.RELAY_ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // hub socket.io (path=/, géré par Caddy)
  const httpServer = createServer();
  const hub = createRelayHub(httpServer, { allowedOrigins: ALLOWED_ORIGINS });
  httpServer.listen(RELAY_PORT, BIND, () => {
    console.warn(`[relay-embarqué] hub socket.io sur ${BIND}:${RELAY_PORT} (path=/)`);
  });

  // endpoint interne /emit + /health — secret éphémère obligatoire
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

  const emitServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/health") {
      send(200, hub.health());
      return;
    }

    if (req.method === "POST" && url.pathname === "/emit") {
      if (req.headers["x-emit-token"] !== secret) {
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
      return;
    }

    send(404, { error: "not found" });
  });

  emitServer.listen(EMIT_PORT, BIND, () => {
    console.warn(
      `[relay-embarqué] /emit sur ${BIND}:${EMIT_PORT} — secret éphémère in-process (F-51)`
    );
  });

  // arrêt propre si le serveur Next s'éteint
  process.once("SIGTERM", () => {
    hub.io.close();
    httpServer.close();
    emitServer.close();
  });
}
