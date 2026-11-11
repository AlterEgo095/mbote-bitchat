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

/** Vérifie une signature ECDSA P-256 (SHA-256) sur un message canonique. */
async function verifySignature(pubkey: string, message: string, ts: unknown, signature: unknown, maxAgeMs: number): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return false;
  if (typeof signature !== "string" || signature.length === 0) return false;
  const tsNum = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return false;
  const age = Date.now() - tsNum;
  if (age > maxAgeMs || age < -HELLO_FUTURE_TOLERANCE_MS) return false;

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
      new TextEncoder().encode(message)
    );
  } catch {
    return false;
  }
}

async function verifyHelloProof(pubkey: string, proof: HelloProof | undefined): Promise<boolean> {
  return verifySignature(
    pubkey,
    `${pubkey}|relay-hello|${(typeof proof?.ts === "number" ? proof.ts : Number(proof?.ts))}`,
    proof?.ts,
    proof?.signature,
    HELLO_MAX_AGE_MS
  );
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
    // C2 : identité PROUVÉE du socket (posée par hello signé) — les événements
    // call:* ne partent QUE de cette identité (anti-usurpation : un socket non
    // prouvé ne peut pas émettre d'offre au nom de qui que ce soit).
    socket.data.pubkey = null as string | null;

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
        socket.data.pubkey = null;
        detachPresence(socket);
        return;
      }

      // F-08 : la boîte DM personnelle n'est ouverte qu'avec une preuve signée ;
      // une clé mal formée ou une preuve absente/échouée → feed seul, pas de
      // présence revendiquée (pas d'usurpation du compteur de présence).
      if (!isValidPubkeyFormat(pubkey)) return;
      const ok = await verifyHelloProof(pubkey, data?.dmAuth);
      if (!ok) {
        socket.data.pubkey = null;
        detachPresence(socket);
        return;
      }

      socket.data.pubkey = pubkey;
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

    // ───────────────────────── C2 : signalisation d'appels ─────────────────────────
    // Le hub est un RELAIS DE SIGNALISATION UNIQUEMENT : SDP/ICE (adresses de
    // transport WebRTC), JAMAIS de média (l'audio est DTLS-SRTP P2P). Chaque
    // événement porte une preuve ECDSA (`${from}|${kind}|${to}|${callId}|${ts}`)
    // vérifiée ICI avant relayage — un socket ne parle qu'au nom de son
    // identité prouvée, vers la room dm:<to> uniquement.
    const CALL_MAX_AGE_MS = 2 * 60_000;
    const CALL_SDP_MAX = 16_384;
    const CALL_ICE_MAX = 2_048;
    const CALL_RATE_PER_MIN = 60;
    let callEventsThisMinute = 0;
    let callWindowStart = Date.now();

    function callRateOk(): boolean {
      const now = Date.now();
      if (now - callWindowStart >= 60_000) {
        callWindowStart = now;
        callEventsThisMinute = 0;
      }
      callEventsThisMinute += 1;
      return callEventsThisMinute <= CALL_RATE_PER_MIN;
    }

    interface CallEnvelope {
      to?: unknown;
      callId?: unknown;
      ts?: unknown;
      sig?: unknown;
      [k: string]: unknown;
    }

    function callEnvelopeOk(data: CallEnvelope, maxPayload: number): { from: string; to: string; callId: string } | null {
      const from = socket.data.pubkey as string | null;
      if (!from) return null; // socket non prouvé → aucune signalisation
      if (!callRateOk()) return null;
      const to = typeof data?.to === "string" ? data.to : null;
      const callId = typeof data?.callId === "string" ? data.callId : null;
      if (!to || !isValidPubkeyFormat(to)) return null;
      if (!callId || callId.length < 8 || callId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(callId)) return null;
      if (JSON.stringify(data ?? {}).length > maxPayload) return null; // borne anti-ampère
      return { from, to, callId };
    }

    async function relayCall(
      kind: "call-offer" | "call-answer" | "call-ice" | "call-hangup" | "call-reject",
      data: CallEnvelope,
      maxPayload: number,
      extraCheck?: (d: CallEnvelope) => boolean
    ): Promise<void> {
      const env = callEnvelopeOk(data, maxPayload);
      if (!env) return;
      if (extraCheck && !extraCheck(data)) return;
      const ok = await verifySignature(
        env.from,
        `${env.from}|${kind}|${env.to}|${env.callId}|${typeof data.ts === "number" ? data.ts : Number(data.ts)}`,
        data.ts,
        data.sig,
        CALL_MAX_AGE_MS
      );
      if (!ok) return; // signature absente/invalide → silencieusement ignoré (pas d'info au spammeur)
      io.to(`dm:${env.to}`).emit(kind, {
        from: env.from,
        to: env.to,
        callId: env.callId,
        ts: data.ts,
        ...data,
      });
    }

    socket.on("call:offer", (d: CallEnvelope) => {
      void relayCall("call-offer", d, CALL_SDP_MAX, (x) =>
        !!(x.offer && typeof (x.offer as { sdp?: unknown }).sdp === "string" && (x.offer as { sdp: string }).sdp.length <= CALL_SDP_MAX)
      );
    });
    socket.on("call:answer", (d: CallEnvelope) => {
      void relayCall("call-answer", d, CALL_SDP_MAX, (x) =>
        !!(x.answer && typeof (x.answer as { sdp?: unknown }).sdp === "string" && (x.answer as { sdp: string }).sdp.length <= CALL_SDP_MAX)
      );
    });
    socket.on("call:ice", (d: CallEnvelope) => {
      void relayCall("call-ice", d, CALL_ICE_MAX, (x) =>
        !!(x.candidate && typeof (x.candidate as { candidate?: unknown }).candidate === "string")
      );
    });
    socket.on("call:hangup", (d: CallEnvelope) => void relayCall("call-hangup", d, CALL_ICE_MAX));
    socket.on("call:reject", (d: CallEnvelope) => void relayCall("call-reject", d, CALL_ICE_MAX));

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
