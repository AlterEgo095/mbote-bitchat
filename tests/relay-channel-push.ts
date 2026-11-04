/** Test E2E du push canal (F-33, audit Vague 5) :
 *  1. un client socket.io joint UNIQUEMENT "channel:<geohash>" via
 *     `subscribe` (jamais "hello" → jamais "feed") ;
 *  2. un post signé entre par le pont avec CE geohash ;
 *  3. le relay doit livrer `post:new` — la seule salle possible est le
 *     CANAL (socket.io déduplique par socket : 1 livraison = 1 preuve) ;
 *  4. après `unsubscribe`, un 2ᵉ post ne doit PLUS être livré.
 *
 *  Usage : bun tests/relay-channel-push.ts   (relay :3030 + serveur :3000)
 */
import { io } from "socket.io-client";
import {
  PROTOCOL_VERSION,
  PKT_PUBLIC,
  TTL_MAX,
  bytesToBase64,
  encodePacket,
  senderIdFromPubkey,
  utf8Encode,
} from "../src/lib/mbote/bitchat-protocol";

const RELAY = "http://localhost:3030";
const API = "http://127.0.0.1:3000";
const GEOHASH = "kdx0v";
const ROOM = `channel:${GEOHASH}`;

// ── paire ECDSA réelle (le pont exige une signature, F-01) ─────────────────
const subtle = globalThis.crypto.subtle;
const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pubRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const PUBKEY = b64url(pubRaw);

let received = 0;
const socket = io(RELAY, { transports: ["websocket", "polling"], forceNew: true });
socket.on("post:new", () => received++);

async function postViaBridge(content: string): Promise<void> {
  const ts = Date.now();
  const signature = b64url(new Uint8Array(await subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    pair.privateKey,
    new TextEncoder().encode(`${PUBKEY}|${content}|${ts}`)
  )));
  const payload = utf8Encode(JSON.stringify({
    kind: "post",
    clientRef: `f33-${ts}`,
    pubkey: PUBKEY,
    nickname: "F33-Test",
    content,
    geohash: GEOHASH,
    precision: 5,
    signature,
    ts,
  }));
  const packet = bytesToBase64(encodePacket({
    version: PROTOCOL_VERSION,
    type: PKT_PUBLIC,
    ttl: TTL_MAX,
    senderId: senderIdFromPubkey(PUBKEY),
    timestamp: Math.floor(ts / 1000),
    payloadLen: payload.length,
    payload,
  }));
  const j = (await (await fetch(`${API}/api/mesh/bridge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gatewayId: "GW-F33-TEST", packets: [packet] }),
  })).json()) as { accepted?: number; invalid?: number };
  if (!j.accepted) throw new Error(`pont a refusé le paquet : ${JSON.stringify(j)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("relay injoignable (12 s)")), 12_000);
  socket.on("connect", () => {
    clearTimeout(timeout);
    resolve();
  });
});
console.log("connecté au relay, id =", socket.id);

// 1. join canal UNIQUEMENT (jamais hello → jamais feed)
socket.emit("subscribe", { rooms: [ROOM] });
await sleep(300);

// 2. post #1 → doit être livré VIA LA SALLE CANAL
await postViaBridge(`Push canal F-33 (${Date.now()})`);
await sleep(1200);
const afterJoin = received;
console.log(`livraisons après join canal : ${afterJoin}`);

// 3. unsubscribe → post #2 ne doit PAS être livré
socket.emit("unsubscribe", { rooms: [ROOM] });
await sleep(300);
await postViaBridge(`Post après désabonnement (${Date.now()})`);
await sleep(1200);
const afterLeave = received;
console.log(`livraisons après unsubscribe : ${afterLeave}`);

socket.close();
const ok = afterJoin >= 1 && afterLeave === afterJoin;
console.log("");
console.log(ok
  ? "F-33 : salle canal JOINIE → push REÇU · unsubscribe → push BLOQUÉ ✅"
  : `F-33 : ❌ (join=${afterJoin}, après leave=${afterLeave})`);
process.exit(ok ? 0 : 1);
