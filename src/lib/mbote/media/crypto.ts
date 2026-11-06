/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  media/crypto — enveloppe de chiffrement par objet (B1, spec §1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Format v1:iv:ciphertext:tag (base64url, sans padding) :
 *   - CEK 32 octets PAR OBJET, généré côté client (JAMAIS serveur) ;
 *   - IV 12 octets ALÉATOIRE UNIQUE par objet (CSPRNG) ;
 *   - AES-256-GCM (tag 16 octets, confidentialité + intégrité).
 *
 *  Garde anti-réutilisation d'IV (spec §1.3) : tout scellé enregistre son IV
 *  dans une registry process-wide (LRU 10 000) — un doublon est un REFUS
 *  EXPLICITE (`MediaCryptoError("iv-reused")`), jamais un chiffrement.
 *  Réutiliser (clé, nonce) en GCM casse la confidentialité ET l'authenticité.
 *
 *  Parse strict : préfixe, nombre de segments, longueurs IV/tag — toute
 *  malformation → `MediaCryptoError("bad-envelope")`, JAMAIS de crash nu.
 *
 *  Zéro dépendance (node:crypto uniquement). Aucune route activée (socle B1).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const ENVELOPE_VERSION = "v1";
/** IV GCM recommandé NIST SP 800-38D : 96 bits. */
export const IV_BYTES = 12;
/** AES-256 : clé 32 octets. */
export const CEK_BYTES = 32;
/** Tag GCM : 128 bits. */
export const TAG_BYTES = 16;

/** Erreurs typées du socle média — jamais de crash nu (directive B1). */
export class MediaCryptoError extends Error {
  constructor(
    public readonly code:
      | "bad-envelope"
      | "bad-cek"
      | "bad-iv"
      | "iv-reused"
      | "auth-failed",
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = "MediaCryptoError";
  }
}

/** Générateur de CEK — CÔTÉ CLIENT uniquement (spec §1.2 ; le serveur ne
 *  l'appelle jamais, il n'en voit que la forme wrappée en B2). */
export function generateCek(): Uint8Array {
  return new Uint8Array(randomBytes(CEK_BYTES));
}

// ── garde anti-réutilisation d'IV (LRU process-wide) ────────────────────────
const IV_REGISTRY_LIMIT = 10_000;
const ivRegistry = new Set<string>();
const ivOrder: string[] = [];

function ivKey(iv: Uint8Array): string {
  return Buffer.from(iv).toString("base64");
}

function registerIv(iv: Uint8Array): void {
  const k = ivKey(iv);
  if (ivRegistry.has(k)) {
    // déjà vu dans la vie du process → réutilisation → refus explicite
    throw new MediaCryptoError("iv-reused", "cet IV a déjà servi (garde process-wide) — GCM interdit la réutilisation (clé, nonce)");
  }
  if (ivRegistry.size >= IV_REGISTRY_LIMIT) {
    const oldest = ivOrder.shift();
    if (oldest) ivRegistry.delete(oldest);
  }
  ivRegistry.add(k);
  ivOrder.push(k);
}

/** IV aléatoire CSPRNG — SANS enregistrement : sealWithIv est le point
 *  UNIQUE de garde (sinon double enregistrement = refus de soi-même). */
function freshIv(): Uint8Array {
  for (let attempt = 0; attempt < 3; attempt++) {
    const iv = new Uint8Array(randomBytes(IV_BYTES));
    if (!ivRegistry.has(ivKey(iv))) {
      return iv;
    }
  }
  // 3 collisions consécutives sur 96 bits aléatoires = CSPRNG cassé
  throw new MediaCryptoError("bad-iv", "CSPRNG suspect (3 collisions d'IV consécutives)");
}

/** Scellé avec un IV FOURNI — usage tests/imports ; refuse toute réutilisation. */
function sealWithIv(plaintext: Uint8Array, cek: Uint8Array, iv: Uint8Array): string {
  if (cek.length !== CEK_BYTES) {
    throw new MediaCryptoError("bad-cek", `CEK doit faire ${CEK_BYTES} octets (reçu ${cek.length})`);
  }
  if (iv.length !== IV_BYTES) {
    throw new MediaCryptoError("bad-iv", `IV doit faire ${IV_BYTES} octets (reçu ${iv.length})`);
  }
  registerIv(iv); // garde : doublon → MediaCryptoError("iv-reused")
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(cek), Buffer.from(iv));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    Buffer.from(iv).toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(":");
}

export interface EncryptedMedia {
  /** enveloppe `v1:iv:ciphertext:tag` (string JSON-safe) */
  envelope: string;
  /** IV utilisé (12 octets) — exposition pour vérification/test */
  iv: Uint8Array;
}

/**
 * Chiffre un objet média : CEK + IV uniques, AES-256-GCM, enveloppe v1.
 * (Le plaintext est typiquement la SORTIE de stripExif — octets propres.)
 */
export function encryptMedia(plaintext: Uint8Array, cek: Uint8Array): EncryptedMedia {
  const iv = freshIv();
  return { envelope: sealWithIv(plaintext, cek, iv), iv };
}

function b64urlToBytes(s: string, what: string, expected: number | null): Buffer {
  const buf = Buffer.from(s, "base64url");
  if (expected !== null && buf.length !== expected) {
    throw new MediaCryptoError(
      "bad-envelope",
      `${what} : ${buf.length} octets, ${expected} attendus`
    );
  }
  return buf;
}

/**
 * Déchiffre une enveloppe v1. Toute altération (ciphertext, tag, IV) →
 * `MediaCryptoError("auth-failed" | "bad-envelope")` — échec PROPRE, pas de
 * crash (garantie testée).
 */
export function decryptMedia(envelope: string, cek: Uint8Array): Uint8Array {
  if (cek.length !== CEK_BYTES) {
    throw new MediaCryptoError("bad-cek", `CEK doit faire ${CEK_BYTES} octets (reçu ${cek.length})`);
  }
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new MediaCryptoError("bad-envelope", "format attendu v1:iv:ciphertext:tag");
  }
  const iv = b64urlToBytes(parts[1], "iv", IV_BYTES);
  const ciphertext = b64urlToBytes(parts[2], "ciphertext", null);
  if (ciphertext.length === 0) {
    throw new MediaCryptoError("bad-envelope", "ciphertext vide");
  }
  const tag = b64urlToBytes(parts[3], "tag", TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(cek), iv);
    decipher.setAuthTag(tag);
    // timingSafeEqual sur le tag est implicite : setAuthTag + final() échoue
    // proprement (throw GCM) si le tag ne correspond pas — catch ci-dessous.
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new MediaCryptoError("auth-failed", "vérification GCM échouée — objet altéré, CEK erroné ou enveloppe tronquée");
  }
}

/** Égalité constante entre deux enveloppes (anti-fuite de timing — debug/tests). */
export function envelopesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Exports internes pour les tests (garde IV, scellé à IV imposé). */
export const __testing = { sealWithIv, registerIv, ivRegistry, IV_REGISTRY_LIMIT, ivKey };
