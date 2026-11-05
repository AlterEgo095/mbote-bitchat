/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS A2 — numéro de sécurité (authentification des clés, lacune L-3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Propriétés exigées par docs/SAFETY-NUMBER-SPEC.md §4 :
 *    1. déterminisme       2. symétrie        3. avalanche (substitution détectable)
 *    4. format 60 chiffres / 12 groupes de 5    5. performance (5200 itérations)
 *
 *  Commande : bun test tests/safety-number.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect } from "bun:test";
import { safetyNumber } from "../src/lib/mbote/safety-number";

// clés factices mais bien formées (65 octets, préfixe 0x04) — la fonction ne
// vérifie PAS la validité ECDSA (elle est une fonction d'affichage sur octets)
function fakeKey(seed: number): string {
  const bytes = new Uint8Array(65);
  bytes[0] = 0x04;
  for (let i = 1; i < 65; i++) bytes[i] = (seed * 31 + i * 7) % 256;
  return Buffer.from(bytes).toString("base64url");
}

const ALICE_KEY = fakeKey(1);
const ALICE_ECDH = fakeKey(2);
const BOB_KEY = fakeKey(3);
const BOB_ECDH = fakeKey(4);
const ATTACKER_ECDH = fakeKey(999); // substitution servie par un serveur hostile

describe("A2 — numéro de sécurité (Signal fingerprint)", () => {
  test("1. déterminisme : mêmes entrées → même numéro", async () => {
    const a = await safetyNumber(ALICE_KEY, ALICE_ECDH, BOB_KEY, BOB_ECDH);
    const b = await safetyNumber(ALICE_KEY, ALICE_ECDH, BOB_KEY, BOB_ECDH);
    expect(a).toBe(b);
  });

  test("2. symétrie : (A,B) = (B,A) — les deux appareils affichent l'identique", async () => {
    const ab = await safetyNumber(ALICE_KEY, ALICE_ECDH, BOB_KEY, BOB_ECDH);
    const ba = await safetyNumber(BOB_KEY, BOB_ECDH, ALICE_KEY, ALICE_ECDH);
    expect(ab).toBe(ba);
  });

  test("4. format : 12 groupes de 5 chiffres = 60 chiffres", async () => {
    const n = await safetyNumber(ALICE_KEY, ALICE_ECDH, BOB_KEY, BOB_ECDH);
    const groups = n.split(" ");
    expect(groups.length).toBe(12);
    expect(groups.every((g) => /^[0-9]{5}$/.test(g))).toBe(true);
    expect(n.replace(/ /g, "")).toHaveLength(60);
  });

  test("3. avalanche : changer 1 BIT d'une clé change le numéro (substitution détectable)", async () => {
    const base = await safetyNumber(ALICE_KEY, ALICE_ECDH, BOB_KEY, BOB_ECDH);
    // mutation d'un seul octet de la clé ECDH du pair (dernier octet ±1)
    const mutated = fakeKey(4);
    const raw = Buffer.from(mutated, "base64url");
    raw[64] = (raw[64] + 1) % 256;
    const flipped = Buffer.from(raw).toString("base64url");
    const withMutated = await safetyNumber(ALICE_KEY, ALICE_ECDH, BOB_KEY, flipped);
    expect(withMutated).not.toBe(base);
    // et une clé SUBSTITUÉE entièrement (attaque L-3) → numéro totalement différent
    const withAttacker = await safetyNumber(ALICE_KEY, ALICE_ECDH, BOB_KEY, ATTACKER_ECDH);
    expect(withAttacker).not.toBe(base);
    expect(withAttacker.split(" ").filter((g, i) => g !== base.split(" ")[i]).length).toBeGreaterThan(9);
  });

  test("5. performance : 5200 itérations SHA-512 en < 2 s (usable en UI)", async () => {
    const t0 = performance.now();
    await safetyNumber(ALICE_KEY, ALICE_ECDH, BOB_KEY, BOB_ECDH);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
  });

  test("clés malformées → erreur (pas de numéro silencieusement faux)", async () => {
    expect(safetyNumber("pas-base64!!", ALICE_ECDH, BOB_KEY, BOB_ECDH)).rejects.toThrow();
  });
});
