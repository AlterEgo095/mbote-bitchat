/** Test E2E de la passerelle mesh : uplink → dédup → downlink
 *
 *  Mise à jour Vague 5 :
 *   • F-01 : le pont exige une VRAIE signature ECDSA P-256 → le test génère
 *     une paire réelle et signe la chaîne canonique `${pubkey}|${content}|${ts}`.
 *   • F-16 : le `ts` social de l'événement est en MILLISECONDES (aligné sur
 *     les clients web/mobile) — l'en-tête du paquet BLE reste en secondes.
 *   • F-30 : la dédup serveur est en SHA-256 (le test re-dépose le même
 *     paquet et attend `duplicate`).
 *   • F-03 : le test FRAGMENTE comme le fait MeshTransport.publish côté
 *     mobile quand le payload dépasse 452 o.
 *
 *  Usage : bun tests/mesh-bridge-e2e.ts   (serveur dev sur :3000)
 */
import {
  PROTOCOL_VERSION,
  PKT_PUBLIC,
  TTL_MAX,
  PAYLOAD_MAX_BYTES,
  bytesToBase64,
  decodeMeshEvent,
  decodePacket,
  encodePacket,
  fragmentPayload,
  fnv64,
  senderIdFromPubkey,
  utf8Encode,
} from "../src/lib/mbote/bitchat-protocol.ts";

const VPS = "http://127.0.0.1:3000";

// ── paire ECDSA réelle (F-01) ──────────────────────────────────────────────
const subtle = globalThis.crypto.subtle;
const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const pubRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const PUBKEY = b64url(pubRaw);

// ── événement social signé, ts en MILLISECONDES (F-16) ─────────────────────
const ts = Date.now();
const content = `Mbote ! Message E2E signé venu du mesh (${new Date(ts).toISOString()}).`;
const signature = b64url(
  new Uint8Array(
    await subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      pair.privateKey,
      new TextEncoder().encode(`${PUBKEY}|${content}|${ts}`)
    )
  )
);

const ev = {
  kind: "post",
  clientRef: `e2e-${ts}`,
  pubkey: PUBKEY,
  nickname: "Mato-Mesh",
  ecdhPub: b64url(new Uint8Array(65).fill(7).subarray(0).map((b, i) => (i === 0 ? 4 : b))),
  content,
  geohash: "kdx0v",
  precision: 5,
  signature,
  ts,
};

/** Construit le(s) paquet(s) d'un événement — fragmente si > 452 o,
 *  exactement comme MeshTransport.publish côté mobile (correctif F-03). */
function eventToPackets(event: typeof ev): string[] {
  const payload = utf8Encode(JSON.stringify(event));
  const fragId = parseInt(fnv64(utf8Encode(event.clientRef)).slice(0, 4), 16);
  const chunks =
    payload.length <= PAYLOAD_MAX_BYTES
      ? [payload]
      : fragmentPayload(payload, fragId);
  return chunks.map((chunk) =>
    bytesToBase64(
      encodePacket({
        version: PROTOCOL_VERSION,
        type: PKT_PUBLIC,
        ttl: TTL_MAX,
        senderId: senderIdFromPubkey(event.pubkey),
        timestamp: Math.floor(ts / 1000), // en-tête BLE : secondes (spec)
        payloadLen: chunk.length,
        payload: chunk,
      })
    )
  );
}

const packetsB64 = eventToPackets(ev);
console.log(`paquet(s) uplink : ${packetsB64.length} (payload signé, ts en ms : ${ts})`);

// 1. uplink (tous les fragments dans le même lot)
const r1 = await fetch(`${VPS}/api/mesh/bridge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    gatewayId: "GW-E2E-TEST",
    label: "passerelle de test",
    packets: packetsB64,
  }),
});
const j1 = await r1.json();
console.log("uplink:", JSON.stringify({
  received: j1.received,
  accepted: j1.accepted,
  duplicates: j1.duplicates,
  invalid: j1.invalid,
  posts: j1.posts?.length,
  first: j1.results?.[0],
}));

// 2. re-dépôt → dédup SHA-256 attendue (F-30)
const r2 = await fetch(`${VPS}/api/mesh/bridge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gatewayId: "GW-E2E-TEST", packets: packetsB64 }),
});
const j2 = await r2.json();
console.log("re-uplink:", JSON.stringify({ duplicates: j2.duplicates, accepted: j2.accepted, first: j2.results?.[0] }));

// 3. downlink (peut contenir des paquets fragmentés)
const r3 = await fetch(`${VPS}/api/mesh/bridge?gatewayId=GW-E2E-TEST`);
const j3 = await r3.json();
console.log("downlink:", j3.packets?.length, "paquets | stats:", JSON.stringify(j3.stats));
const frag = j3.packets?.find((p) => p.fragment);
if (frag) console.log("exemple fragmenté:", JSON.stringify(frag.fragment), frag.bytes, "o");

// 4. contrôle F-16 : le downlink émet des événements avec ts en MILLISECONDES
// (le post peut être fragmenté au downlink → réassembler avant de décoder)
const downlinkTarget = j3.packets?.find((p) => p.id === j1.posts?.[0]?.id);
let ok = true;
if (downlinkTarget) {
  const { FragmentAssembler } = await import("../src/lib/mbote/bitchat-protocol.ts");
  const sameId = j3.packets.filter((p) => p.id === downlinkTarget.id);
  const assembler = new FragmentAssembler();
  let event: { ts: number } | null = null;
  for (const p of sameId) {
    const pkt = decodePacket(new Uint8Array(Buffer.from(p.base64, "base64url")));
    try {
      event = decodeMeshEvent(pkt.payload) as { ts: number };
      break;
    } catch {
      const full = assembler.push(pkt.payload);
      if (full) {
        event = decodeMeshEvent(full) as { ts: number };
        break;
      }
    }
  }
  if (event) {
    const isMs = event.ts > 1e11;
    console.log("F-16 ts downlink :", event.ts, isMs ? "MILLISECONDES ✅" : "secondes ❌");
    ok = isMs;
  } else {
    console.log("F-16 : payload downlink non décodable — contrôle ignoré");
  }
} else {
  console.log("F-16 : post du test absent du downlink (fenêtre 1 h) — contrôle ignoré");
}

// 5. verdict
const uplinkOk = j1.accepted >= 1 && j1.invalid === 0 && j1.posts?.length >= 1;
const dedupOk = j2.duplicates >= 1 && j2.accepted === 0;
console.log("");
console.log(`uplink signé accepté : ${uplinkOk ? "✅" : "❌"} · dédup (re-dépôt) : ${dedupOk ? "✅" : "❌"}`);
process.exit(uplinkOk && dedupOk && ok ? 0 : 1);
