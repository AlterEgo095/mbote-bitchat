"use client";

/**
 * Cryptographie locale (WebCrypto) — Mbote Mesh
 * - Identité : ECDSA P-256 (signature des événements)
 * - DM : ECDH P-256 (dérivation) + AES-GCM 256 (chiffrement de bout en bout)
 *
 * F-06 (audit Vague 2) : les clés privées sont générées NON-EXTRACTIBLES
 * (`extractable: false`) et persistées comme objets CryptoKey dans IndexedDB
 * (voir secure-keys.ts). Le matériel privé (JWK `d`, hex…) ne traverse plus
 * jamais localStorage : un XSS peut abuser d'une signature en session, mais
 * ne peut plus EXFILTRER la clé pour une usurpation permanente ailleurs.
 * Les métadonnées publiques (pubkey, ecdhPub, nickname, bio) restent en
 * localStorage. Migration automatique des identités legacy (JWK en clair) —
 * voir identity.ts.
 */

const SUBTLE = () => {
  if (typeof window === "undefined" || !window.crypto?.subtle) {
    throw new Error("WebCrypto indisponible");
  }
  return window.crypto.subtle;
};

// ---------- helpers base64url ----------

export function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBuf(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function b64urlToBytes(s: string): Uint8Array {
  return new Uint8Array(b64urlToBuf(s));
}

export function strToBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

export function bufToStr(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

// ---------- identité ----------

export interface KeyBundle {
  /** empreinte publique de signature (base64url raw) = identité publique */
  pubkey: string;
  /** clé publique ECDH pour les DM (base64url raw) */
  ecdhPub: string;
  /** clé privée ECDSA NON-EXTRACTIBLE (usage : sign) — ne jamais sérialiser */
  signPriv: CryptoKey;
  /** clé privée ECDH NON-EXTRACTIBLE (usage : deriveBits) — ne jamais sérialiser */
  ecdhPriv: CryptoKey;
}

/** Génère une paire de clés dont la partie privée est NON-EXTRACTIBLE (F-06). */
export async function generateKeyBundle(): Promise<KeyBundle> {
  const subtle = SUBTLE();

  const signPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const ecdhPair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);

  const signPubRaw = await subtle.exportKey("raw", signPair.publicKey);
  const ecdhPubRaw = await subtle.exportKey("raw", ecdhPair.publicKey);

  return {
    pubkey: bufToB64url(signPubRaw),
    ecdhPub: bufToB64url(ecdhPubRaw),
    signPriv: signPair.privateKey,
    ecdhPriv: ecdhPair.privateKey,
  };
}

/**
 * Migration legacy (F-06) : importe des JWK privées legacy (stockées en clair
 * par les versions antérieures) comme clés NON-EXTRACTIBLES — le JWK source
 * peut ensuite être détruit. Les clés publiques sont reconstruites depuis les
 * coordonnées x‖y du JWK (point non compressé 0x04‖X‖Y).
 */
export async function importLegacyKeyBundle(
  signPrivJwk: JsonWebKey,
  ecdhPrivJwk: JsonWebKey
): Promise<KeyBundle> {
  const subtle = SUBTLE();
  if (!signPrivJwk?.d || !ecdhPrivJwk?.d || signPrivJwk.crv !== "P-256") {
    throw new Error("JWK legacy incomplet");
  }

  const signPriv = await subtle.importKey(
    "jwk",
    signPrivJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false, // ← non-extractible à partir d'ici
    ["sign"]
  );
  const ecdhPriv = await subtle.importKey(
    "jwk",
    ecdhPrivJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );

  const toRawPub = (jwk: JsonWebKey): string => {
    const x = b64urlToBytes(String(jwk.x));
    const y = b64urlToBytes(String(jwk.y));
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    raw.set(x, 1);
    raw.set(y, 33);
    return bufToB64url(raw.buffer as ArrayBuffer);
  };

  return {
    pubkey: toRawPub(signPrivJwk),
    ecdhPub: toRawPub(ecdhPrivJwk),
    signPriv,
    ecdhPriv,
  };
}

/** Signe une charge utile (preuve de possession de la clé) */
export async function signPayload(signPriv: CryptoKey, payload: string): Promise<string> {
  const subtle = SUBTLE();
  const sig = await subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    signPriv,
    strToBuf(payload)
  );
  return bufToB64url(sig);
}

// ---------- DM chiffrés (ECDH statique-statique + AES-GCM) ----------

export interface SealedPayload {
  iv: string;
  ciphertext: string;
}

async function deriveDmKey(ecdhPriv: CryptoKey, peerEcdhPubB64: string): Promise<CryptoKey> {
  const subtle = SUBTLE();
  const peerPub = await subtle.importKey(
    "raw",
    b64urlToBuf(peerEcdhPubB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const bits = await subtle.deriveBits({ name: "ECDH", public: peerPub }, ecdhPriv, 256);
  return subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealMessage(
  ecdhPriv: CryptoKey,
  peerEcdhPubB64: string,
  plaintext: string
): Promise<SealedPayload> {
  const subtle = SUBTLE();
  const aesKey = await deriveDmKey(ecdhPriv, peerEcdhPubB64);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    strToBuf(plaintext)
  );
  return { iv: bufToB64url(iv.buffer as ArrayBuffer), ciphertext: bufToB64url(ct) };
}

export async function openMessage(
  ecdhPriv: CryptoKey,
  peerEcdhPubB64: string,
  sealed: SealedPayload
): Promise<string> {
  const subtle = SUBTLE();
  const aesKey = await deriveDmKey(ecdhPriv, peerEcdhPubB64);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(b64urlToBuf(sealed.iv)) },
    aesKey,
    b64urlToBuf(sealed.ciphertext)
  );
  return bufToStr(pt);
}

// ---------- empreintes courtes lisibles ----------

export function shortKey(pubkey: string, size = 6): string {
  return `${pubkey.slice(0, size)}…${pubkey.slice(-4)}`;
}

/** hue déterministe pour les avatars */
export function keyHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
