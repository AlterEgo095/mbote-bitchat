/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  F (Clarification 3) — mapping central statut → message FR : EXHAUSTIVITÉ
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande : bun test tests/f-errors-mapping.test.ts
 *
 *  Garde : chaque code réellement émis par les routes (inventaire grep
 *  'status: [0-9]+' : 400, 401, 403, 404, 405, 409, 410, 413, 422, 429, 500,
 *  502, 503 + défauts 4xx/5xx) a un message FR actionnable ; jsonFetch ne
 *  produit plus jamais « HTTP {status} » brut ; describeApiError route les
 *  erreurs (ApiError / AbortError / réseau / local) vers un message honnête.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, test } from "bun:test";
import { ApiError, describeApiError, describeApiStatus } from "../src/lib/mbote/api";

/** Tous les codes émis par les routes (inventaire Clarification 3). */
const CODES_UTILISES = [400, 401, 403, 404, 405, 409, 410, 413, 422, 429, 500, 502, 503] as const;

describe("describeApiStatus — exhaustivité (Clarification 3)", () => {
  for (const status of CODES_UTILISES) {
    test(`code ${status} → message FR actionnable (non brut)`, () => {
      const msg = describeApiStatus(status);
      expect(msg.length).toBeGreaterThan(15);
      expect(msg).not.toMatch(/^HTTP \d/);
      expect(/[.!?…]/.test(msg)).toBe(true); // phrase complète, pas un jargon
    });
  }

  test("défauts honnêtes : tout autre code ne renvoie jamais de brut", () => {
    for (const status of [402, 406, 408, 415, 418, 423, 451, 501, 504]) {
      const msg = describeApiStatus(status);
      expect(msg.length).toBeGreaterThan(15);
      expect(msg).not.toMatch(/^HTTP \d/);
    }
  });

  test("les 13 codes émis donnent des messages DISTINCTS (pas de mapping écrasé)", () => {
    const messages = CODES_UTILISES.map((s) => describeApiStatus(s));
    expect(new Set(messages).size).toBe(CODES_UTILISES.length);
  });
});

describe("describeApiError — routage honnête", () => {
  test("ApiError sans message serveur → mapping du statut (plus de « HTTP 429 »)", () => {
    const e = new ApiError("HTTP 429", 429);
    const msg = describeApiError(e);
    expect(msg).not.toMatch(/^HTTP \d/);
    expect(msg).toContain("Trop de requêtes");
  });

  test("ApiError avec message serveur FR actionnable → conservé (spécificité préservée)", () => {
    const e = new ApiError(
      "Trop de créations de comptes depuis cette adresse — réessayez plus tard (3 comptes par heure).",
      429
    );
    expect(describeApiError(e)).toContain("3 comptes par heure");
  });

  test("ApiError 401 sans corps → message session actionnable", () => {
    expect(describeApiError(new ApiError("HTTP 401", 401))).toContain("Session absente ou expirée");
  });

  test("AbortError → délai dépassé actionnable", () => {
    const e = new DOMException("The operation was aborted", "AbortError");
    expect(describeApiError(e)).toContain("Délai dépassé");
  });

  test("TypeError (transport réseau) → message hors-ligne actionnable", () => {
    expect(describeApiError(new TypeError("Failed to fetch"))).toContain("file locale");
  });

  test("erreur locale FR → message conservé", () => {
    expect(describeApiError(new Error("Aucune identité locale"))).toBe("Aucune identité locale");
  });

  test("inconnu → fallback honnête", () => {
    expect(describeApiError("garbage").length).toBeGreaterThan(15);
    expect(describeApiError(undefined).length).toBeGreaterThan(15);
  });
});
