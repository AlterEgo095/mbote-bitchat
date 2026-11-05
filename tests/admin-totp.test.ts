/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS ADM Étape 3 — TOTP RFC 6238 (vecteurs normatifs + anti-rejeu)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : bun test tests/admin-totp.test.ts
 *
 *  1. Vecteurs NORMATIFS du RFC 6238 Appendice B (HMAC-SHA-1, secret ASCII
 *     "12345678901234567890") — équivalents 6 chiffres (même troncature
 *     dynamique : code8 % 10^6) :
 *        T=59s          94287082 → 287082
 *        T=1111111109s  07081804 → 081804
 *        T=1111111111s  14050471 → 050471
 *        T=1234567890s  89005924 → 005924
 *        T=2000000000s  69279037 → 279037
 *        T=20000000000s 65353130 → 353130
 *  2. base32 RFC 4648 : aller-retour + vecteur de référence.
 *  3. Fenêtre ±1 (±30 s — pas plus) + anti-rejeu par compteur persisté.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect } from "bun:test";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpAt,
  verifyTotp,
} from "../src/lib/mbote/totp";

const RFC_SECRET_ASCII = "12345678901234567890";
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"));

// T (secondes) → code 8 chiffres (RFC) → équivalent 6 chiffres
const RFC_VECTORS: Array<[number, string, string]> = [
  [59, "94287082", "287082"],
  [1111111109, "07081804", "081804"],
  [1111111111, "14050471", "050471"],
  [1234567890, "89005924", "005924"],
  [2000000000, "69279037", "279037"],
  [20000000000, "65353130", "353130"],
];

describe("ADM Étape 3 — TOTP RFC 6238 (SHA-1, 6 chiffres, 30 s)", () => {
  test("vecteur base32 de référence (RFC 4648) — encodeur sans padding, décodeur tolérant", () => {
    // l'encodeur omet le padding (forme acceptée par les apps authenticator)
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    // le décodeur tolère les deux formes (avec/sans '=')
    expect(Buffer.from(base32Decode("MZXW6YTBOI======")).toString()).toBe("foobar");
    expect(Buffer.from(base32Decode("MZXW6YTBOI")).toString()).toBe("foobar");
  });

  for (const [tSec, code8, code6] of RFC_VECTORS) {
    test(`RFC 6238 App. B — T=${tSec}s → ${code8} → 6 chiffres ${code6}`, () => {
      const { code, counter } = totpAt(RFC_SECRET_B32, tSec * 1000);
      expect(code).toBe(code6);
      expect(counter).toBe(Math.floor(tSec / 30));
    });
  }

  test("génération de secret : 20 octets → 32 chars base32, unique", () => {
    const s1 = generateTotpSecret();
    const s2 = generateTotpSecret();
    expect(s1).toHaveLength(32);
    expect(s1).not.toBe(s2);
    expect(base32Decode(s1)).toHaveLength(20);
  });

  test("fenêtre ±1 : code du compteur −1 et +1 acceptés (±30 s, pas plus)", () => {
    const secret = generateTotpSecret();
    const nowMs = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, nowMs - 30_000).code, { atMs: nowMs }).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, nowMs + 30_000).code, { atMs: nowMs }).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, nowMs).code, { atMs: nowMs }).ok).toBe(true);
    // ±2 intervalles (±60 s) = REFUS — directive : « ±30 s, pas plus »
    expect(verifyTotp(secret, totpAt(secret, nowMs - 60_000).code, { atMs: nowMs }).ok).toBe(false);
    expect(verifyTotp(secret, totpAt(secret, nowMs + 60_000).code, { atMs: nowMs }).ok).toBe(false);
    expect(verifyTotp(secret, totpAt(secret, nowMs - 90_000).code, { atMs: nowMs }).ok).toBe(false);
  });

  test("anti-rejeu : un compteur déjà VALIDÉ (≤ lastCounter) est refusé", () => {
    const secret = generateTotpSecret();
    const nowMs = 1_700_000_060_000; // compteur pair stable
    const current = Math.floor(nowMs / 1000 / 30);
    // premier succès → counter persisté
    const first = verifyTotp(secret, totpAt(secret, nowMs).code, { atMs: nowMs, lastCounter: null });
    expect(first.ok).toBe(true);
    expect(first.counter).toBe(current);
    // rejeu du MÊME code → refus
    const replay = verifyTotp(secret, totpAt(secret, nowMs).code, { atMs: nowMs, lastCounter: first.counter });
    expect(replay.ok).toBe(false);
    // compteur +1 (code suivant) reste acceptable
    const next = verifyTotp(secret, totpAt(secret, nowMs + 30_000).code, {
      atMs: nowMs + 30_000,
      lastCounter: first.counter,
    });
    expect(next.ok).toBe(true);
    expect(next.counter).toBe(current + 1);
  });

  test("entrées invalides : code non numérique / vide / secret vide → refus", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "", {}).ok).toBe(false);
    expect(verifyTotp(secret, "abcdef", {}).ok).toBe(false);
    expect(verifyTotp(secret, "12345", {}).ok).toBe(false);
    expect(verifyTotp(secret, "1234567", {}).ok).toBe(false);
    // espaces tolérés (saisie humaine « 123 456 »)
    const { code } = totpAt(secret);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, {}).ok).toBe(true);
  });
});
