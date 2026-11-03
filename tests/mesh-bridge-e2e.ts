/** Test E2E de la passerelle mesh : uplink → dédup → downlink */
import { buildPacket, bytesToBase64 } from "../src/lib/mbote/bitchat-protocol.ts";

const VPS = "http://127.0.0.1:3000";

const ev = {
  kind: "post",
  clientRef: `e2e-${Date.now()}`,
  pubkey: "ZlRlc3RQYXJfbWVzaF9FMkVfamlzdHVf",
  nickname: "Mato-Mesh",
  ecdhPub: "cHVibGtleWNvdGVDaGlmZnJlMTIzNDU2",
  content: "Mbote ! Premier message venu du mesh via la passerelle.",
  geohash: "kdx0v",
  precision: 5,
  signature: "sig-demo-e2e",
  ts: Math.floor(Date.now() / 1000),
};
const packetB64 = bytesToBase64(buildPacket(0x02, ev.pubkey, ev, { ttl: 4 }));
console.log("paquet uplink :", packetB64.length, "chars (base64)");

// 1. uplink
const r1 = await fetch(`${VPS}/api/mesh/bridge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gatewayId: "GW-E2E-TEST", label: "passerelle de test", packets: [packetB64] }),
});
const j1 = await r1.json();
console.log("uplink:", JSON.stringify({ received: j1.received, accepted: j1.accepted, duplicates: j1.duplicates, invalid: j1.invalid, posts: j1.posts?.length, first: j1.results?.[0] }));

// 2. re-dépôt → dédup attendue
const r2 = await fetch(`${VPS}/api/mesh/bridge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gatewayId: "GW-E2E-TEST", packets: [packetB64] }),
});
const j2 = await r2.json();
console.log("re-uplink:", JSON.stringify({ duplicates: j2.duplicates, accepted: j2.accepted, first: j2.results?.[0] }));

// 3. downlink (peut contenir des paquets fragmentés)
const r3 = await fetch(`${VPS}/api/mesh/bridge?gatewayId=GW-E2E-TEST`);
const j3 = await r3.json();
console.log("downlink:", j3.packets?.length, "paquets | stats:", JSON.stringify(j3.stats));
const frag = j3.packets?.find((p) => p.fragment);
if (frag) console.log("exemple fragmenté:", JSON.stringify(frag.fragment), frag.bytes, "o");
process.exit(0);
