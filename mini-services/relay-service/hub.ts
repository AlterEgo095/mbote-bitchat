/**
 * Mbote Relay Hub — cœur du hub temps réel (rooms, présence, preuve hello)
 *
 * INDÉPENDANT DU RUNTIME (Bun ET Node) — utilisé par deux Points d'entrée :
 *  1. mini-services/relay-service/index.ts → déploiement Docker/VPS
 *     (conteneur autonome, ports 3030 public / 3031 interne) ;
 *  2. src/lib/mbote/embedded-relay.ts (via src/instrumentation.ts) → mode
 *     dev/sandbox : le hub tourne EMBARQUÉ dans le processus Next.js lui-même
 *     (un seul processus supervisé — pas de service séparé à maintenir en vie).
 *
 * Une seule implémentation = zéro dérive (leçon F-22) : rooms, preuve de
 * possession ECDSA du hello (F-08) et comptage de présence vivent ICI.
 */

import { Server as SocketIOServer, type Socket } from "socket.io";

// ───────────────────────── F-08 : vérification autonome ─────────────────────────
// Miroir minimal de src/lib/mbote/proof.ts (le relay est un contexte Docker
// autonome : pas d'import transversal). WebCrypto uniquement — disponible
// dans Bun comme dans Node ≥ 20.

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

// ───────────────────────── création du hub ─────────────────────────

export interface RelayHub {
  /** serveur socket.io attaché (rooms feed / channel:<gh> / dm:<pubkey>) */
  io: SocketIOServer;
  /** diffuse un événement (endpoint interne /emit, F-51 : token requis) */
  emitEvent(event: string, payload: unknown, rooms?: string[]): void;
  /** état de santé (GET /health) */
  health(): { ok: true; clients: number; identitiesOnline: number };
}

/** F-08 : origines croisées autorisées — vide = aucune (même origine via Caddy). */
export function createRelayHub(
  httpServer: import("http").Server,
  opts: { allowedOrigins: string[] }
): RelayHub {
  const io = new SocketIOServer(httpServer, {
    // DO NOT change the path, it is used by Caddy to forward the request to the correct port
    path: "/",
    cors: {
      origin: opts.allowedOrigins.length > 0 ? opts.allowedOrigins : false,
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
      // présence revendiquée (pas d'usurpation du compteur de présence).
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

  return {
    io,
    emitEvent(event, payload, rooms) {
      if (Array.isArray(rooms) && rooms.length > 0) {
        io.to(rooms).emit(event, payload);
      } else {
        io.emit(event, payload);
      }
    },
    health() {
      return { ok: true as const, clients: io.engine.clientsCount, identitiesOnline: countOnline() };
    },
  };
}
