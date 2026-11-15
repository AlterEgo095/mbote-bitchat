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
import { openSecureDb } from "./secure-db";

const STORE = "keys";
const RECORD_ID = "identity";

export interface SecureKeyRecord extends KeyBundle {
  id: string;
  savedAt: number;
}

// BUG FAMILLE #47 (vague G) : l'ouverture locale v1 est SUPPRIMÉE — tout
// passe par l'ouvreur unique openSecureDb() (version 2, stores idempotents).
// Une ouverture v1 après un upgrade MLS v2 levait VersionError, avalée par le
// catch ci-dessous → identité perdue au reload (docs/proofs/G-i18n.md §1).

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
    const db = await openSecureDb();
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
  } catch (err) {
    // « Jamais silencieux » : un null ici signifie « pas de clés → onboarding »
    // — comportement fail-closed voulu, mais la CAUSE doit rester diagnosable
    // (un catch muet a masqué le VersionError #47 des semaines durant —
    // cf. secure-db.ts).
    console.warn("[secure-keys] coffre illisible — identité non restaurée", err);
    return null;
  }
}

/** Persiste le bundle de clés (CryptoKeys clonables). */
export async function putSecureKeys(bundle: KeyBundle): Promise<void> {
  const db = await openSecureDb();
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
    const db = await openSecureDb();
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
