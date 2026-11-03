/**
 * Mbote Relay Service — hub temps réel (socket.io)
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
 * F-08 (audit Vague 2) :
 *  - CORS restreint : par défaut AUCUNE origine croisée (le navigateur passe
 *    par la même origine via Caddy — CORS n'est utile qu'aux tiers) ;
 *    `RELAY_ALLOWED_ORIGIN` (liste séparée par des virgules) pour ouvrir
 *    explicitement des origines de confiance.
 *  - `dm:<pubkey>` exige une preuve de possession ECDSA P-256
 *    (`${pubkey}|relay-hello|${ts}`, fenêtre courte) — fini le join
 *    anonyme qui fuyait les métadonnées (timing/paires) cross-origin.
 *    Sans preuve : la connexion reste dans "feed" uniquement et ne
 *    revendique PAS la présence.
 */

import { createServer } from "http";
import { Server, type Socket } from "socket.io";

const RELAY_PORT = 3030; // public (navigateurs) — NE PAS changer le path, géré par Caddy
const EMIT_PORT = 3031; // interne (routes API Next.js → notifications)
// F-51 : token optionnel pour /emit — RELAY_EMIT_TOKEN défini = exigé (header
// x-emit-token) ; vide (défaut sandbox) = contrôle désactivé (réseau Docker interne).
const EMIT_TOKEN = process.env.RELAY_EMIT_TOKEN ?? "";

// ───────────────────────── F-08 : vérification autonome ─────────────────────────
// Miroir minimal de src/lib/mbote/proof.ts (le relay est un contexte Docker
// autonome : pas d'import transversal). WebCrypto uniquement — disponible dans Bun.

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64urlToBytes(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (clean.length === 0) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_ALPHABET.indexOf(clean[i]);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

function isValidPubkeyFormat(pubkey: unknown): pubkey is string {
  const bytes = typeof pubkey === "string" ? b64urlToBytes(pubkey) : null;
  return !!bytes && bytes.length === 65 && bytes[0] === 0x04;
}

const HELLO_MAX_AGE_MS = 15 * 60_000;
const HELLO_FUTURE_TOLERANCE_MS = 2 * 60_000;

interface HelloProof {
  ts?: unknown;
  signature?: unknown;
}

async function verifyHelloProof(pubkey: string, proof: HelloProof | undefined): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return false;
  const ts = proof?.ts;
  const signature = proof?.signature;
  if (typeof signature !== "string" || signature.length === 0) return false;
  const tsNum = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return false;
  const age = Date.now() - tsNum;
  if (age > HELLO_MAX_AGE_MS || age < -HELLO_FUTURE_TOLERANCE_MS) return false;

  const pubBytes = b64urlToBytes(pubkey);
  const sigBytes = b64urlToBytes(signature);
  if (!pubBytes || !sigBytes) return false;
  try {
    const key = await subtle.importKey(
      "raw",
      pubBytes as unknown as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return await subtle.verify(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      key,
      sigBytes as unknown as BufferSource,
      new TextEncoder().encode(`${pubkey}|relay-hello|${tsNum}`)
    );
  } catch {
    return false;
  }
}

// ───────────────────────── serveur socket.io public ─────────────────────────

/** F-08 : origines croisées autorisées — vide = aucune (même origine via Caddy). */
const ALLOWED_ORIGINS = (process.env.RELAY_ALLOWED_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: "/",
  cors: {
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

/** Présence : comptage des identités réellement connectées (1 clé = N onglets) */
const onlineKeys = new Map<string, Set<string>>(); // pubkey -> socket ids

function countOnline(): number {
  return onlineKeys.size;
}

function broadcastPresence(): void {
  io.emit("presence:update", { online: countOnline() });
}

function attachPresence(socket: Socket, pubkey: string | null): void {
  if (!pubkey || typeof pubkey !== "string" || pubkey.length < 8) return;
  let sockets = onlineKeys.get(pubkey);
  if (!sockets) {
    sockets = new Set();
    onlineKeys.set(pubkey, sockets);
  }
  sockets.add(socket.id);
  broadcastPresence();
}

function detachPresence(socket: Socket): void {
  for (const [key, sockets] of onlineKeys) {
    if (sockets.delete(socket.id) && sockets.size === 0) {
      onlineKeys.delete(key);
      broadcastPresence();
    }
  }
}

io.on("connection", (socket) => {
  socket.on("hello", async (data: {
    pubkey?: string | null;
    nickname?: string | null;
    /** F-08 : preuve de possession pour ouvrir dm:<pubkey> */
    dmAuth?: { ts?: number; signature?: string };
  }) => {
    const pubkey = typeof data?.pubkey === "string" ? data.pubkey : null;
    // room par défaut : fil public (toujours ouvert)
    socket.join("feed");

    if (!pubkey) {
      detachPresence(socket);
      return;
    }

    // F-08 : la boîte DM personnelle n'est ouverte qu'avec une preuve signée ;
    // une clé mal formée ou une preuve absente/échouée → feed seul, pas de
    // présence revendiquée (pas d'usurpation de compteur de présence).
    if (!isValidPubkeyFormat(pubkey)) return;
    const ok = await verifyHelloProof(pubkey, data?.dmAuth);
    if (!ok) {
      detachPresence(socket);
      return;
    }

    socket.join(`dm:${pubkey}`);
    // re-hello (ex. après panic wipe) → l'ancienne présence de CE socket est d'abord retirée
    detachPresence(socket);
    attachPresence(socket, pubkey);
  });

  // abonnement à des salles supplémentaires (canaux géohash ouverts…)
  socket.on("subscribe", (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms.slice(0, 20) : [];
    for (const room of rooms) {
      if (typeof room !== "string" || room.length === 0 || room.length >= 64) continue;
      // F-08 : une boîte DM ne s'ouvre JAMAIS via subscribe — hello signé only
      if (room.startsWith("dm:")) continue;
      socket.join(room);
    }
  });

  socket.on("unsubscribe", (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms.slice(0, 20) : [];
    for (const room of rooms) socket.leave(room);
  });

  socket.on("disconnect", () => detachPresence(socket));
});

httpServer.listen(RELAY_PORT, () => {
  console.log(`[relay] socket.io hub démarré sur :${RELAY_PORT} (path=/)`);
  console.log(
    `[relay] CORS : ${ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(", ") : "aucune origine croisée (même origine via Caddy)"}`
  );
});

// ---------- endpoint interne d'émission (routes API Next.js) ----------

Bun.serve({
  port: EMIT_PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        clients: io.engine.clientsCount,
        identitiesOnline: countOnline(),
      });
    }

    if (req.method === "POST" && url.pathname === "/emit") {
      if (EMIT_TOKEN && req.headers.get("x-emit-token") !== EMIT_TOKEN) {
        return Response.json({ error: "token requis" }, { status: 401 });
      }
      return req
        .json()
        .then(
          (
            body:
              | { event?: string; payload?: unknown; rooms?: string[] }
              | undefined
          ) => {
            const { event, payload, rooms } = body ?? {};
            if (!event || typeof event !== "string") {
              return Response.json({ error: "event requis" }, { status: 400 });
            }
            const safeRooms = Array.isArray(rooms)
              ? rooms.filter(
                  (r): r is string => typeof r === "string" && r.length > 0 && r.length < 64
                )
              : undefined;
            if (safeRooms && safeRooms.length > 0) {
              io.to(safeRooms).emit(event, payload);
            } else {
              io.emit(event, payload);
            }
            return Response.json({ ok: true });
          }
        )
        .catch(() => Response.json({ error: "JSON invalide" }, { status: 400 }));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[relay] endpoint interne d'émission sur :${EMIT_PORT} (/emit, /health)`);

// ---------- arrêt propre ----------

process.on("SIGTERM", () => {
  console.log("[relay] SIGTERM — arrêt…");
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

process.on("SIGINT", () => {
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
