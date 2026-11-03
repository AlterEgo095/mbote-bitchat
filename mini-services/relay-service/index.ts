/**
 * Mbote Relay Service — hub temps réel (socket.io)
 *
 * Deux ports :
 *  - 3030 (public, via Caddy XTransformPort) : connexions navigateurs socket.io
 *   Rooms :
 *      · "feed"            → tout le fil public
 *      · "channel:<gh>"    → un canal géohash précis
 *      · "dm:<pubkey>"     → boîte à lettres privée d'une identité
 *  - 3031 (interne uniquement) : POST /emit depuis les routes API Next.js
 *    pour diffuser un événement sans jamais bloquer la requête HTTP principale.
 *
 * Événements diffusés :
 *  post:new | post:like | dm:new | identity:new | presence:update
 */

import { createServer } from "http";
import { Server, type Socket } from "socket.io";

const RELAY_PORT = 3030; // public (navigateurs) — NE PAS changer le path, géré par Caddy
const EMIT_PORT = 3031; // interne (routes API Next.js → notifications)

// ---------- serveur socket.io public ----------

const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: "/",
  cors: {
    origin: "*",
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
  if (!onlineKeys.has(pubkey)) onlineKeys.set(pubkey, new Set());
  onlineKeys.get(pubkey)!.add(socket.id);
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
  socket.on("hello", (data: { pubkey?: string | null; nickname?: string | null }) => {
    const pubkey = data?.pubkey ?? null;
    // rooms par défaut : fil public + boîte DM personnelle
    socket.join("feed");
    if (pubkey) socket.join(`dm:${pubkey}`);
    // re-hello (ex. après panic wipe) → l'ancienne présence de CE socket est d'abord retirée
    detachPresence(socket);
    attachPresence(socket, pubkey);
  });

  // abonnement à des salles supplémentaires (canaux géohash ouverts…)
  socket.on("subscribe", (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms.slice(0, 20) : [];
    for (const room of rooms) {
      if (typeof room === "string" && room.length > 0 && room.length < 64) {
        socket.join(room);
      }
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
