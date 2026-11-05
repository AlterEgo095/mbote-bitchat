/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  MBOTE MESH — CŒUR BITCHAT (couche transport native)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Réimplémentation TypeScript isomorphe du protocole BitChat (whitepaper v2.0,
 *  domaine public, permissionlesstech/bitchat). Ce fichier est le « core »
 *  embarquable tel quel dans une application native (React Native / Expo)
 *  ainsi que dans le serveur : zéro dépendance DOM, zéro Buffer, zéro Node API.
 *
 *  Paramètres fidèles au whitepaper :
 *    • TTL max 7 — clampé à 5 quand la densité ≥ 6 voisins
 *    • gigue (jitter) de retransmission : 10–220 ms
 *    • déduplication : LRU 1000 entrées (empreinte du paquet)
 *    • paquet ≤ 469 octets (MTU GATT 512 − surcoût BLE)
 *    • retransmission à inondation contrôlée (controlled flood)
 *    • senderID = 8 octets du fingerprint de la clé publique
 *
 *  Types de paquets :
 *    0x01 ANNOUNCE        présence + clés publiques (pubkey, ecdhPub, nickname)
 *    0x02 PUBLIC_CHANNEL  publication de canal (signée, portée par le mesh)
 *    0x03 PRIVATE_SEALED  DM scellé Noise-X (iv + ciphertext opaques)
 *    0x04 GOSSIP_SYNC     réconciliation d'historique (filtres GCS)
 *
 *  C'est ce fichier que l'app natif embarque : le module BLE (react-native-ble-plx)
 *  fournit les octets, le présent core fournit la logique de routage.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ───────────────────────────── Constantes protocole ─────────────────────────

export const PROTOCOL_VERSION = 1;

/** Types de paquets */
export const PKT_ANNOUNCE = 0x01;
export const PKT_PUBLIC = 0x02;
export const PKT_PRIVATE = 0x03;
export const PKT_GOSSIP = 0x04;

/** Paramètres BitChat (whitepaper §3, §4) */
export const TTL_MAX = 7;
export const DENSITY_THRESHOLD = 6; // ≥ 6 voisins → zone dense
export const TTL_DENSE = 5; // TTL clampé en zone dense
export const JITTER_MIN_MS = 10;
export const JITTER_MAX_MS = 220;
export const DEDUP_CAPACITY = 1000;
export const PACKET_OVERHEAD = 17; // en-tête binaire ci-dessous
export const PACKET_MAX_BYTES = 469; // budget total (MTU 512 − surcoût GATT)
export const PAYLOAD_MAX_BYTES = PACKET_MAX_BYTES - PACKET_OVERHEAD;

/** En-tête : version(1) type(1) ttl(1) senderID(8) timestamp(4) payloadLen(2) */
export const HEADER_SIZE = PACKET_OVERHEAD;

export const PACKET_TYPE_NAMES: Record<number, string> = {
  [PKT_ANNOUNCE]: "ANNOUNCE",
  [PKT_PUBLIC]: "PUBLIC_CHANNEL",
  [PKT_PRIVATE]: "PRIVATE_SEALED",
  [PKT_GOSSIP]: "GOSSIP_SYNC",
};

// ───────────────────────────── Helpers binaires purs ────────────────────────

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 standard, 100 % JS (navigateur, serveur, React Native) */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    out +=
      B64_ALPHABET[b0 >> 2] +
      B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)] +
      (has1 ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=") +
      (has2 ? B64_ALPHABET[b2 & 0x3f] : "=");
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_ALPHABET.indexOf(clean[i]);
    if (v < 0) throw new Error("base64 invalide");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

const HEX_ALPHABET = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_ALPHABET[bytes[i] >> 4] + HEX_ALPHABET[bytes[i] & 0x0f];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** FNV-1a 64 bits sur octets → hex 16 chars (empreinte de dédup, pas de la crypto) */
export function fnv64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * A1 / L-5 (crypto spec §lacunes) — empreinte de dédup CRYPTOGRAPHIQUE :
 * SHA-256 tronquée à 128 bits (hex 32 chars). Remplace le FNV-64 forgable
 * partout où la synchronicité n'est pas imposée par l'hôte (WebCrypto est
 * asynchrone). Le FNV-64 reste uniquement pour les usages NON-sécurité
 * (fragId de fragmentation, affichage) et le repli documenté ci-dessous.
 * Parité web ↔ mobile verrouillée par scripts/check-protocol-parity.ts.
 */
export async function dedupFingerprint(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return bytesToHex(new Uint8Array(digest).slice(0, 16));
  }
  // Repli documenté (hôte sans WebCrypto) : FNV-64 — dégradation ASSUMÉE et
  // traçable : la dédup mesh n'est qu'un filtre anti-inondation local, la
  // garantie anti-rejeu forte vit côté serveur (garde persistante SHA-256).
  return fnv64(bytes);
}

/** Octets aléatoires isomorphes */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const g = globalThis.crypto;
  if (g?.getRandomValues) {
    g.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

// ───────────────────────────── Identités mesh ───────────────────────────────

/**
 * senderID BitChat : 8 octets du fingerprint de la clé publique.
 * Ici : les 8 premiers octets de la clé brute (base64url) si décodable,
 * sinon empreinte FNV de la chaîne.
 */
export function senderIdFromPubkey(pubkeyB64url: string): Uint8Array {
  try {
    const raw = base64ToBytes(pubkeyB64url.replace(/-/g, "+").replace(/_/g, "/"));
    if (raw.length >= 8) return raw.slice(0, 8);
  } catch {
    /* clé non décodable → fallback */
  }
  return hexToBytes(fnv64(utf8Encode(pubkeyB64url)).slice(0, 16));
}

/** ID d'affichage court (hex) pour les logs mesh */
export function shortSenderId(bytes: Uint8Array): string {
  return bytesToHex(bytes.slice(0, 4)).toUpperCase();
}

// ───────────────────────────── En-tête de paquet ────────────────────────────

export interface PacketHeader {
  version: number;
  type: number;
  ttl: number;
  senderId: Uint8Array; // 8 octets
  timestamp: number; // secondes unix
  payloadLen: number;
}

export interface BitChatPacket extends PacketHeader {
  payload: Uint8Array;
}

/** Sérialise un paquet complet (en-tête + payload) */
export function encodePacket(pkt: BitChatPacket): Uint8Array {
  if (pkt.senderId.length !== 8) throw new Error("senderID doit faire 8 octets");
  if (pkt.payload.length > PAYLOAD_MAX_BYTES) {
    throw new Error(
      `payload trop grand (${pkt.payload.length} > ${PAYLOAD_MAX_BYTES}) — fragmenter`
    );
  }
  const out = new Uint8Array(HEADER_SIZE + pkt.payload.length);
  const dv = new DataView(out.buffer);
  out[0] = pkt.version & 0xff;
  out[1] = pkt.type & 0xff;
  out[2] = pkt.ttl & 0x0f;
  out.set(pkt.senderId, 3);
  dv.setUint32(11, Math.floor(pkt.timestamp) >>> 0, false);
  dv.setUint16(15, pkt.payload.length, false);
  out.set(pkt.payload, HEADER_SIZE);
  return out;
}

/** Décode un paquet brut — lève si l'en-tête est invalide */
export function decodePacket(bytes: Uint8Array): BitChatPacket {
  if (bytes.length < HEADER_SIZE) throw new Error("paquet tronqué");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  if (version !== PROTOCOL_VERSION) throw new Error(`version inconnue ${version}`);
  const type = bytes[1];
  if (!(type in PACKET_TYPE_NAMES)) throw new Error(`type inconnu 0x${type.toString(16)}`);
  const ttl = bytes[2] & 0x0f;
  const senderId = bytes.slice(3, 11);
  const timestamp = dv.getUint32(11, false);
  const payloadLen = dv.getUint16(15, false);
  if (HEADER_SIZE + payloadLen > bytes.length) throw new Error("payload tronqué");
  return {
    version,
    type,
    ttl,
    senderId,
    timestamp,
    payloadLen,
    payload: bytes.slice(HEADER_SIZE, HEADER_SIZE + payloadLen),
  };
}

/** Décrémente le TTL et resérialise (cœur de la retransmission mesh) */
export function forwardPacket(pkt: BitChatPacket): Uint8Array | null {
  if (pkt.ttl <= 1) return null; // dernier saut : on ne retransmet pas
  return encodePacket({ ...pkt, ttl: pkt.ttl - 1 });
}

// ───────────────────────────── Dédup LRU (whitepaper §4.2) ──────────────────

export class DedupCache {
  private seen = new Map<string, number>();
  constructor(private capacity = DEDUP_CAPACITY) {}

  /** true si le paquet est NOUVEAU (et donc à traiter), false si doublon */
  checkAndRecord(bytes: Uint8Array): boolean {
    const key = fnv64(bytes);
    if (this.seen.has(key)) {
      // rafraîchit la position LRU
      this.seen.delete(key);
      this.seen.set(key, Date.now());
      return false;
    }
    this.seen.set(key, Date.now());
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

// ───────────────────────────── Retransmission (§3.2) ────────────────────────

/**
 * Gigue de retransmission BitChat : délai aléatoire 10–220 ms avant de
 * retransmettre, pour éviter les collisions radio (CSMA doux).
 */
export function retransmitJitter(): number {
  return JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1));
}

/** TTL applicable selon la densité locale (§3.1 : clamp zone dense) */
export function ttlForDensity(neighborCount: number): number {
  return neighborCount >= DENSITY_THRESHOLD ? TTL_DENSE : TTL_MAX;
}

// ───────────────────────────── Fragmentation (§2) ───────────────────────────

/**
 * Fragmente une charge utile > PAYLOAD_MAX en blocs de paquets FRAG.
 * Format interne Mbote (dérivé du §2 du whitepaper) :
 *   fragId(2) index(1) total(1) chunk
 * Chaque bloc est ensuite enveloppé en paquet standard type PUBLIC/PRIVATE.
 */
export function fragmentPayload(payload: Uint8Array, fragId: number): Uint8Array[] {
  const chunkSize = PAYLOAD_MAX_BYTES - 4;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint16(0, fragId, false);
    head[2] = chunks.length;
    head[3] = Math.ceil(payload.length / chunkSize);
    const merged = new Uint8Array(4 + chunk.length);
    merged.set(head, 0);
    merged.set(chunk, 4);
    chunks.push(merged);
  }
  return chunks;
}

export class FragmentAssembler {
  private parts = new Map<number, Map<number, Uint8Array>>();
  private totals = new Map<number, number>();

  /** Retourne la charge utile complète si le fragment final est arrivé */
  push(chunk: Uint8Array): Uint8Array | null {
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const fragId = dv.getUint16(0, false);
    const index = chunk[2];
    const total = chunk[3];
    this.totals.set(fragId, total);
    if (!this.parts.has(fragId)) this.parts.set(fragId, new Map());
    this.parts.get(fragId)!.set(index, chunk.slice(4));
    const bag = this.parts.get(fragId)!;
    if (bag.size < total) return null;
    const merged = new Uint8Array(
      [...bag.values()].reduce((acc, b) => acc + b.length, 0)
    );
    let off = 0;
    for (let i = 0; i < total; i++) {
      const part = bag.get(i);
      if (!part) return null; // trou — attendre
      merged.set(part, off);
      off += part.length;
    }
    this.parts.delete(fragId);
    this.totals.delete(fragId);
    return merged;
  }
}

// ───────────────────── Événements sociaux transportés (§5) ──────────────────

/**
 * Le payload des paquets ANNOUNCE / PUBLIC / PRIVATE transporte un
 * « événement social » JSON signé côté appareil. Le serveur ne fait que
 * dédupliquer + agréger : le modèle « enveloppes opaques » de BitChat/Nostr.
 */
export type MeshEvent =
  | {
      kind: "announce";
      pubkey: string; // clé de signature (base64url) = identité
      nickname: string;
      ecdhPub?: string; // clé ECDH pour les DM
      ts: number;
    }
  | {
      kind: "post";
      clientRef: string; // id client (dédup bout-en-bout)
      pubkey: string;
      nickname: string;
      ecdhPub?: string;
      content: string;
      geohash?: string | null;
      precision?: number | null;
      parentId?: string | null;
      signature?: string | null; // ECDSA sur `${pubkey}|${content}|${ts}`
      ts: number;
    }
  | {
      kind: "dm";
      senderPub: string;
      recipientPub: string;
      iv: string;
      ciphertext: string; // opaque pour relais et passerelles
      /** A1 : identifiant client (uuid) + séquence monotone — signés dm2 côté
       *  /api/dms ; sur le pont ils ne sont PAS signés (événements opaques) et
       *  la garde serveur lie au payload, pas à ces métadonnées. */
      msgId?: string;
      seq?: number;
      ts: number;
    };

export function encodeMeshEvent(ev: MeshEvent): Uint8Array {
  return utf8Encode(JSON.stringify(ev));
}

export function decodeMeshEvent(payload: Uint8Array): MeshEvent {
  return JSON.parse(utf8Decode(payload)) as MeshEvent;
}

/** Construit un paquet complet prêt à l'émission BLE/bridge */
export function buildPacket(
  type: number,
  senderPubkeyB64url: string,
  ev: MeshEvent,
  opts?: { ttl?: number; now?: number }
): Uint8Array {
  return encodePacket({
    version: PROTOCOL_VERSION,
    type,
    ttl: opts?.ttl ?? ttlForDensity(0),
    senderId: senderIdFromPubkey(senderPubkeyB64url),
    timestamp: opts?.now ?? Math.floor(Date.now() / 1000),
    payloadLen: 0, // recalculé par encodePacket
    payload: encodeMeshEvent(ev),
  });
}

/** Résumé lisible d'un paquet (UI / journal passerelle) */
export function describePacket(bytes: Uint8Array): {
  header: PacketHeader;
  typeName: string;
  totalBytes: number;
  hash: string;
  event?: MeshEvent;
} {
  const pkt = decodePacket(bytes);
  let event: MeshEvent | undefined;
  try {
    event = decodeMeshEvent(pkt.payload);
  } catch {
    /* payload non JSON (ex. DM scellé brut) — affiché hex */
  }
  return {
    header: pkt,
    typeName: PACKET_TYPE_NAMES[pkt.type] ?? `0x${pkt.type.toString(16)}`,
    totalBytes: bytes.length,
    hash: fnv64(bytes),
    event,
  };
}

/** Dump hexadécimal lisible (16 octets/ligne) pour l'UI */
export function hexDump(bytes: Uint8Array, maxRows = 12): string {
  const rows: string[] = [];
  for (let i = 0; i < bytes.length && rows.length < maxRows; i += 16) {
    const slice = bytes.slice(i, i + 16);
    const hex = bytesToHex(slice).match(/.{2}/g)?.join(" ") ?? "";
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("");
    rows.push(`${i.toString(16).padStart(4, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > maxRows * 16) rows.push(`…  (${bytes.length - maxRows * 16} octets restants)`);
  return rows.join("\n");
}
