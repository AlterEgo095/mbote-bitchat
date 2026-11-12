"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  mls/store — persistence de l'état MLS dans le coffre IndexedDB chiffré
 * ─────────────────────────────────────────────────────────────────────────────
 *  Même coffre que les clés identité (secure-keys.ts, DB « mbote-secure ») —
 *  version 2 ajoute le store « mls ». Chaque record est SCELLÉ (AES-GCM via
 *  ECDH-soi : la clé de déchiffrement n'est dérivable qu'avec la clé privée
 *  ECDH NON-EXTRACTIBLE de l'identité — le matériel MLS ne vit jamais en clair
 *  sur le disque, exigence directive « IndexedDB chiffré comme les clés
 *  identité »).
 *
 *  Record : { id: serverGroupId, mlsGroupId, sealed: {iv, ciphertext},
 *  lastEpoch, savedAt }. Le payload scellé = serializeGroupState(GroupState).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SealedPayload } from "../crypto";
import { sealMessage, openMessage } from "../crypto";
import { serializeGroupState, deserializeGroupState } from "./state-codec";

const DB_NAME = "mbote-secure";
const DB_VERSION = 2; // +1 : store « mls » (secure-keys.ts est v1)
const STORE = "mls";

export interface MlsStateRecord {
  id: string; // serverGroupId (cuid) — la clé du store
  mlsGroupId: string; // hex du groupId MLS (diagnostique)
  sealed: SealedPayload; // état scellé (JSON du GroupState)
  lastEpoch: string; // epoch lisible (diagnostique UI)
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB indisponible"));
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

export async function loadGroupState(
  serverGroupId: string,
  ecdhPriv: CryptoKey,
  ownEcdhPubB64: string
): Promise<Record<string, unknown> | null> {
  try {
    const db = await openDb();
    try {
      const rec = await new Promise<MlsStateRecord | null>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(serverGroupId);
        req.onsuccess = () => resolve((req.result as MlsStateRecord) ?? null);
        req.onerror = () => reject(req.error);
      });
      if (!rec) return null;
      const plaintext = await openMessage(ecdhPriv, ownEcdhPubB64, rec.sealed);
      return deserializeGroupState(plaintext);
    } finally {
      db.close();
    }
  } catch {
    return null; // pas de state / IMPOSSIBLE de déchiffrer → re-synchro complète
  }
}

export async function saveGroupState(
  serverGroupId: string,
  mlsGroupIdHex: string,
  state: Record<string, unknown>,
  ecdhPriv: CryptoKey,
  ownEcdhPubB64: string
): Promise<void> {
  const plaintext = serializeGroupState(state);
  const sealed = await sealMessage(ecdhPriv, ownEcdhPubB64, plaintext);
  const epoch = (state.groupContext as Record<string, unknown> | undefined)?.epoch;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const rec: MlsStateRecord = {
      id: serverGroupId,
      mlsGroupId: mlsGroupIdHex,
      sealed,
      lastEpoch: epoch != null ? String(epoch) : "?",
      savedAt: Date.now(),
    };
    tx.objectStore(STORE).put(rec);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function deleteGroupState(serverGroupId: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(serverGroupId);
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    /* déjà absent */
  }
}

/** Panique : efface TOUT le store MLS (wipe global de l'app). */
export async function clearAllGroupStates(): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    /* base absente */
  }
}

// ── cache des key packages privés (survit aux rechargements) ────────────────

/** Clés privées des key packages PUBLIÉS — scellées comme l'état de groupe. */
const KP_CACHE_ID = "__kp_cache";

export async function loadKpCache(): Promise<Array<{ wire: string; pub: unknown; priv: unknown }> | null> {
  try {
    const me = identityHandle();
    if (!me) return null;
    const db = await openDb();
    try {
      const rec = await new Promise<{ id: string; sealed: SealedPayload } | null>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(KP_CACHE_ID);
        req.onsuccess = () => resolve((req.result as { id: string; sealed: SealedPayload }) ?? null);
        req.onerror = () => reject(req.error);
      });
      if (!rec) return null;
      const plaintext = await openMessage(me.ecdhPriv, me.ecdhPub, rec.sealed);
      return JSON.parse(plaintext) as Array<{ wire: string; pub: unknown; priv: unknown }>;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function saveKpCache(entries: Array<{ wire: string; pub: unknown; priv: unknown }>): Promise<void> {
  const me = identityHandle();
  if (!me) return; // identité absente — pas de persistence (reconnect obligatoire)
  const sealed = await sealMessage(me.ecdhPriv, me.ecdhPub, JSON.stringify(entries));
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id: KP_CACHE_ID, sealed });
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** Injecteur d'identité pour le store (set depuis client.ts via setMlsIdentity). */
let identityHandle: () => { ecdhPriv: CryptoKey; ecdhPub: string } | null = () => null;
export function setStoreIdentity(fn: () => { ecdhPriv: CryptoKey; ecdhPub: string } | null): void {
  identityHandle = fn;
}
