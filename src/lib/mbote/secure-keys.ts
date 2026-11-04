"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  secure-keys — coffre IndexedDB des clés privées (F-06, audit Vague 2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Les clés privées (objets CryptoKey NON-EXTRACTIBLES) sont clonées dans
 *  IndexedDB — un CryptoKey est « structured-cloneable » dans tous les
 *  navigateurs modernes. Conséquences :
 *    • le matériel privé n'apparaît plus en clair dans localStorage (F-06) ;
 *    • la clé ne peut PAS être exportée/exfiltrée : un XSS peut signer en
 *      session, mais pas voler l'identité de façon permanente ;
 *    • la clé survit aux rechargements (comportement identique à l'ancien
 *      stockage localStorage).
 *
 *  Record stocké : { id: "identity", pubkey, ecdhPub, signPriv, ecdhPriv,
 *  savedAt }. Les métadonnées publiques (nickname, bio) restent en
 *  localStorage (voir identity.ts).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { KeyBundle } from "./crypto";

const DB_NAME = "mbote-secure";
const DB_VERSION = 1;
const STORE = "keys";
const RECORD_ID = "identity";

export interface SecureKeyRecord extends KeyBundle {
  id: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB indisponible (navigation privée stricte ?)"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("ouverture IndexedDB échouée"));
    req.onblocked = () => reject(new Error("IndexedDB bloquée par un autre onglet"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction IndexedDB annulée"));
    tx.onerror = () => reject(tx.error ?? new Error("transaction IndexedDB échouée"));
  });
}

/** Lit le record de clés (null si absent). Ne lève jamais pour un simple absent. */
export async function getSecureKeys(): Promise<SecureKeyRecord | null> {
  try {
    const db = await openDb();
    try {
      const rec = await new Promise<SecureKeyRecord | null>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(RECORD_ID);
        req.onsuccess = () => resolve((req.result as SecureKeyRecord) ?? null);
        req.onerror = () => reject(req.error);
      });
      return rec;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Persiste le bundle de clés (CryptoKeys clonables). */
export async function putSecureKeys(bundle: KeyBundle): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      id: RECORD_ID,
      pubkey: bundle.pubkey,
      ecdhPub: bundle.ecdhPub,
      signPriv: bundle.signPriv,
      ecdhPriv: bundle.ecdhPriv,
      savedAt: Date.now(),
    } satisfies SecureKeyRecord);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** Supprime le record de clés (panic wipe). */
export async function clearSecureKeys(): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(RECORD_ID);
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    /* base déjà absente : rien à faire */
  }
}
