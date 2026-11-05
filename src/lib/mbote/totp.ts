/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  totp — RFC 6238 (HMAC-SHA-1, 6 chiffres, période 30 s, fenêtre ±1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  ADM Étape 3 — ARBITRAGE DOCUMENTÉ : la spec Étape 1 (ADMIN-RBAC.md §7.1)
 *  citait `otplib`. Implémentation RFC 6238 maison préférée, justifiée par :
 *   - la primitive cryptographique (HMAC-SHA-1) reste déléguée à `node:crypto`
 *     (vétérée) — rien n'est réinventé au niveau crypto ;
 *   - l'algorithme est validé contre les vecteurs de test NORMATIFS du RFC
 *     6238 Appendice B (tests/admin-totp.test.ts) — preuve rejouable ;
 *   - contrôle explicite du compteur 30 s (anti-rejeu : un code déjà validé
 *     est refusé — exigence « TOTP rejoué → 401 » de la directive Étape 3),
 *     sans dépendre des internes d'une lib tierce (risque bundling Next 16).
 *
 *  Fenêtre : ±1 intervalle = ±30 s — PAS PLUS (directive Étape 3, explicite).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_S = 30;
const DIGITS = 6;
export const TOTP_WINDOW = 1; // ±1 intervalle = ±30 s — pas plus.

/** Secret TOTP : 20 octets aléatoires (160 bits), encodés base32 (RFC 4648). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(new Uint8Array(randomBytes(bytes)));
}

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("base32: caractère invalide");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** RFC 4226 (HOTP) — truncate dynamique, 6 chiffres décimaux. */
function hotp(secretB32: string, counter: number): string {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** Code TOTP courant (utilitaire de test / CLI). */
export function totpAt(secretB32: string, atMs = Date.now()): { code: string; counter: number } {
  const counter = Math.floor(atMs / 1000 / PERIOD_S);
  return { code: hotp(secretB32, counter), counter };
}

export interface TotpVerifyResult {
  ok: boolean;
  /** compteur 30 s validé (à persister pour l'anti-rejeu) — null si échec */
  counter: number | null;
}

/**
 * Vérifie un code TOTP avec fenêtre ±1 intervalle et garde anti-rejeu :
 * un compteur ≤ `lastCounter` (dernier code VALIDÉ) est un rejeu → refus.
 * Comparaison timing-safe sur les 6 caractères.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  opts: { atMs?: number; lastCounter?: number | null } = {}
): TotpVerifyResult {
  const normalized = (code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return { ok: false, counter: null };
  const atMs = opts.atMs ?? Date.now();
  const current = Math.floor(atMs / 1000 / PERIOD_S);
  for (const delta of [0, TOTP_WINDOW, -TOTP_WINDOW]) {
    const counter = current + delta;
    if (opts.lastCounter != null && counter <= opts.lastCounter) continue; // anti-rejeu
    const expected = hotp(secretB32, counter);
    const a = Buffer.from(expected);
    const b = Buffer.from(normalized);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { ok: true, counter };
    }
  }
  return { ok: false, counter: null };
}

/** URI otpauth:// pour l'app authenticator (label = Mbote Admin:<email>). */
export function buildOtpauthUri(email: string, secretB32: string): string {
  const label = encodeURIComponent(`Mbote Admin:${email}`);
  return (
    `otpauth://totp/${label}?secret=${secretB32}` +
    `&issuer=${encodeURIComponent("Mbote Admin")}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_S}`
  );
}
