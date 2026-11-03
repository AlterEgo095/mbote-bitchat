/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  check-protocol-parity — F-22 (audit Vague 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le protocole BitChat est DUPONIQUÉ web ↔ mobile (contrainte Expo : les
 *  fichiers isomorphes ne peuvent pas être partagés via le bundler Next).
 *  Sans garde, une modification d'un côté dérive silencieusement de l'autre
 *  → paquets illisibles cross-plateforme (le pire bug possible du produit).
 *
 *  Politique de parité (choix professionnel) : PARITÉ SÉMANTIQUE, pas
 *  textuelle. Les deux implémentations sont importées et comparées sur leur
 *  COMPORTEMENT :
 *    1. constantes du protocole (version, tailles, TTL, seuils) ;
 *    2. round-trip binaire encodePacket ↔ decodePacket identique octet par
 *       octet entre les deux implémentations ;
 *    3. fragmentation identique (mêmes fragments produits) ;
 *    4. empreinte FNV-64 identique (dédup cross-plateforme) ;
 *    5. backoff outbox identique (courbes de rejeu synchronisées).
 *
 *  Les divergences de STYLE interne (refactors locaux) sont volontairement
 *  tolérées — seules les divergences de CONTRACT font échouer la vérification.
 *
 *  Usage : bun scripts/check-protocol-parity.ts   (exit 1 si dérive)
 *  CI : exécuté par build-android.yml / build-ios.yml avant chaque build.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as web from "../src/lib/mbote/bitchat-protocol";
import * as mob from "../mobile/src/core/bitchat-protocol";
import { outboxBackoffMs as webBackoff } from "../src/lib/mbote/transports/outbox-core";
import { outboxBackoffMs as mobBackoff } from "../mobile/src/transport/outbox-core";

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("── Constantes du protocole ──");
check("PROTOCOL_VERSION", web.PROTOCOL_VERSION === mob.PROTOCOL_VERSION,
  `web=${web.PROTOCOL_VERSION} mobile=${mob.PROTOCOL_VERSION}`);
check("PKT_ANNOUNCE/PUBLIC/PRIVATE/GOSSIP",
  web.PKT_ANNOUNCE === mob.PKT_ANNOUNCE &&
  web.PKT_PUBLIC === mob.PKT_PUBLIC &&
  web.PKT_PRIVATE === mob.PKT_PRIVATE &&
  web.PKT_GOSSIP === mob.PKT_GOSSIP);
check("TTL_MAX / DENSITY_THRESHOLD / TTL_DENSE",
  web.TTL_MAX === mob.TTL_MAX &&
  web.DENSITY_THRESHOLD === mob.DENSITY_THRESHOLD &&
  web.TTL_DENSE === mob.TTL_DENSE);
check("PACKET_MAX_BYTES / PAYLOAD_MAX_BYTES / PACKET_OVERHEAD",
  web.PACKET_MAX_BYTES === mob.PACKET_MAX_BYTES &&
  web.PAYLOAD_MAX_BYTES === mob.PAYLOAD_MAX_BYTES &&
  web.PACKET_OVERHEAD === mob.PACKET_OVERHEAD,
  `web=${web.PACKET_MAX_BYTES}/${web.PAYLOAD_MAX_BYTES} mobile=${mob.PACKET_MAX_BYTES}/${mob.PAYLOAD_MAX_BYTES}`);

console.log("── Round-trip binaire (encode ↔ decode) ──");
// le même paquet encodé par chaque implémentation doit produire LES MÊMES OCTETS
const sampleEvent = {
  kind: "post" as const,
  clientRef: "parity-1",
  pubkey: "A".repeat(43),
  nickname: "parité",
  content: "Message de parité web ↔ mobile — accents, emoji 📡, et piége de fin.",
  geohash: "kr4zk",
  precision: 5,
  ts: 1700000000000,
};
const webPkt = web.buildPacket(web.PKT_PUBLIC, sampleEvent.pubkey, sampleEvent, { ttl: 5, now: 1700000000 });
const mobPkt = mob.buildPacket(mob.PKT_PUBLIC, sampleEvent.pubkey, sampleEvent, { ttl: 5, now: 1700000000 });
check("buildPacket octets identiques", web.bytesToHex(webPkt) === mob.bytesToHex(mobPkt),
  `web=${web.bytesToHex(webPkt).slice(0, 32)}… mobile=${mob.bytesToHex(mobPkt).slice(0, 32)}…`);

// et le decode croisé doit lire l'implémentation voisine
const webDecodedByMobile = mob.decodePacket(webPkt);
const mobDecodedByWeb = web.decodePacket(mobPkt);
check("decode croisé (web→mobile)",
  webDecodedByMobile.type === mobDecodedByWeb.type &&
  web.bytesToHex(webDecodedByMobile.payload) === web.bytesToHex(mobDecodedByWeb.payload) &&
  webDecodedByMobile.senderId.length === mobDecodedByWeb.senderId.length);

console.log("── Fragmentation ──");
// payload > PAYLOAD_MAX : les deux implémentations doivent produire des fragments interchangeables
const bigPayload = web.utf8Encode("x".repeat(web.PAYLOAD_MAX_BYTES * 2 + 100));
const webFrags = web.fragmentPayload(bigPayload, 0x1234);
const mobFrags = mob.fragmentPayload(bigPayload, 0x1234);
check("même nombre de fragments", webFrags.length === mobFrags.length,
  `web=${webFrags.length} mobile=${mobFrags.length}`);
check("fragments octets identiques",
  webFrags.length === mobFrags.length &&
  webFrags.every((f, i) => web.bytesToHex(f) === mob.bytesToHex(mobFrags[i])));
// réassembly croisé : les fragments produits par WEB, poussés dans un
// assembleur MOBILE, doivent reconstituer le payload d'origine (format
// fragId(2) index(1) total(1) chunk identique des deux côtés)
check("réassembly croisé web→mobile", (() => {
  try {
    const assembler = new mob.FragmentAssembler();
    let out: Uint8Array | null = null;
    for (const f of webFrags) out = assembler.push(f.slice());
    return out !== null && web.bytesToHex(out) === web.bytesToHex(bigPayload);
  } catch {
    return false;
  }
})());

console.log("── Empreinte FNV-64 (dédup cross-plateforme) ──");
check("fnv64 identique", web.fnv64(webPkt) === mob.fnv64(mobPkt) && web.fnv64(bigPayload) === mob.fnv64(bigPayload));

console.log("── Backoff outbox (courbe de rejeu) ──");
let backoffOk = true;
for (let attempts = 0; attempts <= 12; attempts++) {
  if (webBackoff(attempts) !== mobBackoff(attempts)) {
    backoffOk = false;
    console.error(`    divergence à attempts=${attempts} : web=${webBackoff(attempts)} mobile=${mobBackoff(attempts)}`);
    break;
  }
}
check("outboxBackoffMs identique (0..12 tentatives)", backoffOk);

console.log("");
if (failures > 0) {
  console.error(`PARITÉ PROTOCOLE ROMPUE : ${failures} divergence(s). ` +
    "Synchroniser src/lib/mbote/bitchat-protocol.ts ↔ mobile/src/core/bitchat-protocol.ts " +
    "(et transports/outbox-core.ts) avant de merger.");
  process.exit(1);
}
console.log("Parité protocole web ↔ mobile : OK (contrat sémantique respecté).");
