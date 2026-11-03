/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Cryptographie locale — Mbote BitChat MOBILE (React Native / Hermes)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Miroir de `src/lib/mbote/crypto.ts` (web/WebCrypto) mais 100 % JavaScript
 *  via les bibliothèques auditées @noble — aucun module natif requis, donc
 *  builds Expo reproductibles.
 *
 *  Interopérabilité garantie avec le web :
 *    • Identité  : ECDSA P-256 + SHA-256, signature brute r‖s (64 octets)
 *      → identique à WebCrypto ECDSA { namedCurve: P-256 }
 *    • DM        : ECDH P-256 (secret = coordonnée X, 32 octets) + AES-256-GCM
 *      → identique à WebCrypto deriveBits(ECDH, 256) + AES-GCM
 *    • Clés publiques : point non compressé 65 octets (0x04‖X‖Y), base64url
 *
 *  F-06 (audit Vague 2) : les clés privées ne résident plus dans AsyncStorage
 *  (lisible par tout le sandbox JS, commentaire « chiffré » inexact) mais dans
 *  expo-secure-store — Keychain iOS / Keystore Android (matériel chiffré).
 *  Migration automatique de l'ancien stockage AsyncStorage au premier lancement.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import { bytesToBase64, base64ToBytes, utf8Encode, utf8Decode, randomBytes, bytesToHex, hexToBytes } from "./bitchat-protocol";

// ---------- helpers base64url / hex ----------

export function bufToB64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return base64ToBytes(padded);
}

export function strToBytes(s: string): Uint8Array {
  return utf8Encode(s);
}

export function bytesToStr(b: Uint8Array): string {
  return utf8Decode(b);
}

// ---------- identité ----------

export interface KeyBundle {
  /** clé publique de signature (base64url raw 65 octets) = identité publique */
  pubkey: string;
  /** clé publique ECDH pour les DM (base64url raw 65 octets) */
  ecdhPub: string;
  /** clés privées hexadécimales (restent locales) */
  signPrivHex: string;
  ecdhPrivHex: string;
}

const STORAGE_KEY = "mbote.identity.v1";
/** Ancien emplacement AsyncStorage (F-06) — même nom, autre store ; migré puis supprimé. */
const LEGACY_ASYNC_KEY = "mbote.identity.v1";

export async function generateKeyBundle(): Promise<KeyBundle> {
  const signPriv = p256.utils.randomPrivateKey();
  const ecdhPriv = p256.utils.randomPrivateKey();
  const signPub = p256.getPublicKey(signPriv); // 65 octets 0x04‖X‖Y
  const ecdhPubRaw = p256.getPublicKey(ecdhPriv);

  return {
    pubkey: bufToB64url(signPub),
    ecdhPub: bufToB64url(ecdhPubRaw),
    signPrivHex: bytesToHex(signPriv),
    ecdhPrivHex: bytesToHex(ecdhPriv),
  };
}

/**
 * Charge l'identité persistée ou en crée une neuve (idempotent).
 * F-06 : stockage via expo-secure-store (Keychain/Keystore) ; une identité
 * legacy trouvée dans AsyncStorage est migrée puis EFFACÉE de AsyncStorage.
 */
export async function loadOrCreateKeyBundle(): Promise<KeyBundle> {
  // 1) chemin nominal : SecureStore
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as KeyBundle;
      if (parsed.pubkey && parsed.signPrivHex) return parsed;
    }
  } catch {
    /* SecureStore indisponible (Expo Go web ?) → repli legacy ci-dessous */
  }

  // 2) migration legacy : AsyncStorage (ancien stockage en clair)
  try {
    const legacyRaw = await AsyncStorage.getItem(LEGACY_ASYNC_KEY);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw) as KeyBundle;
      if (parsed.pubkey && parsed.signPrivHex) {
        try {
          await SecureStore.setItemAsync(STORAGE_KEY, legacyRaw);
        } catch {
          /* pas de SecureStore : on garde le bundle en mémoire pour cette session */
          return parsed;
        }
        await AsyncStorage.removeItem(LEGACY_ASYNC_KEY); // le matériel privé quitte AsyncStorage
        return parsed;
      }
      await AsyncStorage.removeItem(LEGACY_ASYNC_KEY); // corrompu → repartir propre
    }
  } catch {
    /* AsyncStorage indisponible : continuer */
  }

  // 3) création fraîche
  const fresh = await generateKeyBundle();
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(fresh));
  } catch {
    /* repli : session-only (pas de persistance insécurisée) */
  }
  return fresh;
}

/** Panic wipe : efface le coffre ET tout vestige legacy AsyncStorage (F-11). */
export async function wipeIdentity(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {
    /* déjà absent / store indisponible */
  }
  try {
    await AsyncStorage.removeItem(LEGACY_ASYNC_KEY);
  } catch {
    /* déjà absent */
  }
}

/** Signe une charge utile — signature brute r‖s (64 octets), compatible WebCrypto */
export async function signPayload(signPrivHex: string, payload: string): Promise<string> {
  const hash = sha256(strToBytes(payload));
  const sig = p256.sign(hash, hexToBytes(signPrivHex));
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  return bufToB64url(hexToBytes(r + s));
}

/** Vérifie une signature brute r‖s contre une clé publique base64url */
export function verifyPayload(pubkeyB64url: string, payload: string, sigB64url: string): boolean {
  try {
    const hash = sha256(strToBytes(payload));
    return p256.verify(b64urlToBytes(sigB64url), hash, b64urlToBytes(pubkeyB64url));
  } catch {
    return false;
  }
}

// ---------- DM chiffrés (ECDH statique-statique + AES-256-GCM) ----------

export interface SealedPayload {
  iv: string;
  ciphertext: string;
}

/**
 * Secret partagé = coordonnée X (32 octets) du point ECDH — résultat
 * strictement identique à WebCrypto deriveBits({ name: "ECDH" }, 256).
 */
function sharedSecret(ecdhPrivHex: string, peerEcdhPubB64url: string): Uint8Array {
  const secret = p256.getSharedSecret(hexToBytes(ecdhPrivHex), b64urlToBytes(peerEcdhPubB64url));
  return secret.slice(1, 33);
}

export async function sealMessage(
  ecdhPrivHex: string,
  peerEcdhPubB64: string,
  plaintext: string
): Promise<SealedPayload> {
  const key = sharedSecret(ecdhPrivHex, peerEcdhPubB64);
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(strToBytes(plaintext));
  return { iv: bufToB64url(iv), ciphertext: bufToB64url(ct) };
}

export async function openMessage(
  ecdhPrivHex: string,
  peerEcdhPubB64: string,
  sealed: SealedPayload
): Promise<string> {
  const key = sharedSecret(ecdhPrivHex, peerEcdhPubB64);
  const pt = gcm(key, b64urlToBytes(sealed.iv)).decrypt(b64urlToBytes(sealed.ciphertext));
  return bytesToStr(pt);
}

// ---------- empreintes courtes lisibles ----------

export function shortKey(pubkey: string, size = 6): string {
  return `${pubkey.slice(0, size)}…${pubkey.slice(-4)}`;
}

/** teinte déterministe pour les avatars */
export function keyHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
