"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  secure-db — OUVERTURE UNIQUE du coffre IndexedDB « mbote-secure »
 * ─────────────────────────────────────────────────────────────────────────────
 *  BUG FAMILLE #47 (vague F §9, corrigé vague G — Clarification 1) :
 *  secure-keys.ts ouvrait la base en version 1 pendant que mls/store.ts
 *  l'ouvrait en version 2 (store « mls » ajouté par C4). Après le PREMIER
 *  flux MLS (upgrade 1→2), chaque rechargement re-ouvrait la base en v1 →
 *  VersionError (spec IndexedDB : version demandée < version existante) —
 *  erreur avalée par `catch → return null` — → loadIdentity() renvoyait null
 *  ALORS QUE le localStorage contenait encore l'identité → dialog d'onboarding
 *  au reload + createGroupCount 0 (docs/proofs/F-ui-fixes.md §9 ; diagnostic :
 *  docs/proofs/G-i18n.md §1). Déterministe à 100 % dès le premier open v2,
 *  cohérent avec « P3/P4 re-naviguaient pageA AVANT MLS sans perte ».
 *
 *  FIX : UN SEUL point d'ouverture, UNE SEULE version (2), création
 *  IDEMPOTENTE des deux stores (« keys » depuis v1, « mls » depuis v2).
 *  Quel que soit le module (identité ou MLS), quel que soit l'ordre des
 *  appels et quel que soit l'état antérieur de la base (absente, v1, v2),
 *  l'ouverture est conforme et jamais en conflit.
 *
 *  POLITIQUE D'ÉVOLUTION : toute addition de store passe PAR ICI
 *  (SECURE_DB_VERSION +1 et onupgradeneeded idempotent) — plus jamais de
 *  constante de version IndexedDB locale dans un module client.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const SECURE_DB_NAME = "mbote-secure";
/** v1 : store « keys » (identité — secure-keys.ts) ; v2 : store « mls » (C4). */
export const SECURE_DB_VERSION = 2;

export function openSecureDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB indisponible"));
      return;
    }
    const req = indexedDB.open(SECURE_DB_NAME, SECURE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Idempotent : chaque store n'est créé qu'une fois, quel que soit le
      // chemin d'upgrade (0→2 création fraîche, 1→2 base legacy F-06) et
      // quel que soit le module qui déclenche l'ouverture en premier.
      if (!db.objectStoreNames.contains("keys")) {
        db.createObjectStore("keys", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("mls")) {
        db.createObjectStore("mls", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("ouverture IndexedDB échouée"));
    req.onblocked = () => reject(new Error("IndexedDB bloquée par un autre onglet"));
  });
}
