"use client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  identité locale — web (F-06 + F-11, audit Vague 2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  • Métadonnées PUBLIQUES (pubkey, ecdhPub, nickname, bio) → localStorage.
 *  • Clés PRIVÉES (CryptoKey non-extractibles) → IndexedDB `mbote-secure`
 *    (secure-keys.ts) — plus jamais de JWK `d` en clair dans localStorage.
 *  • Migration automatique : une identité legacy (JWK en clair) est réimportée
 *    comme non-extractible puis son matériel privé est détruit du localStorage.
 *  • Panic wipe (F-11) : efface TOUT l'état local promis par l'UI — clés
 *    (IndexedDB + localStorage), outbox sociale (LS), outbox durable binaire
 *    (IndexedDB `mbote-outbox` + repli LS), mode mesh forcé, thème.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { LS_IDENTITY, LS_OUTBOX, LS_FORCE_OFFLINE } from "./constants";
import { importLegacyKeyBundle, type KeyBundle } from "./crypto";
import { clearSecureKeys, getSecureKeys, putSecureKeys } from "./secure-keys";

// ── F-31 : politique de purge unifiée des DEUX outboxes ──
// L'app porte deux files aux rôles distincts et complémentaires :
//   • outbox SOCIALE (cette file, LS, JSON) — actions signées vers l'API
//     (identity, post, like, dm) ; purgée par ACK du serveur ;
//   • outbox DURABLE binaire (outbox-core, IndexedDB/SQLite, paquets
//     BitChat base64) — plafond 1000, backoff 30 s→15 min, purge poison.
// Historiquement leurs politiques divergaient (la sociale n'avait NI âge NI
// plafond) : des enveloppes dont la preuve avait expiré (> 7 j, rejetées 401)
// y pourrissaient à jamais. Alignement :
const SOCIAL_OUTBOX_MAX_ITEMS = 200;
const SOCIAL_OUTBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // = ACTION_MAX_AGE_MS (proof.ts)

export interface StoredIdentity extends KeyBundle {
  nickname: string;
  bio?: string;
}

/** Métadonnées publiques uniquement (localStorage — aucun matériel privé). */
export interface StoredIdentityMeta {
  pubkey: string;
  ecdhPub: string;
  nickname: string;
  bio?: string;
}

/** Ancien format (Vague 1 et avant) : JWK privées en clair — migration F-06. */
interface LegacyStoredIdentity extends StoredIdentityMeta {
  signPrivJwk?: JsonWebKey;
  ecdhPrivJwk?: JsonWebKey;
}

function defaultNickname(pubkey: string): string {
  return `mbote-${pubkey.slice(0, 4)}`;
}

/** Lecture SYNCHRONE des métadonnées publiques (pour les IDs de passerelle…). */
export function loadIdentityMeta(): StoredIdentityMeta | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LS_IDENTITY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacyStoredIdentity;
    if (!parsed?.pubkey) return null;
    return {
      pubkey: parsed.pubkey,
      ecdhPub: parsed.ecdhPub ?? "",
      nickname: parsed.nickname || defaultNickname(parsed.pubkey),
      bio: parsed.bio,
    };
  } catch {
    return null;
  }
}

/**
 * Charge l'identité complète (métadonnées + clés privées non-extractibles).
 * Effectue la migration legacy F-06 au premier passage :
 * JWK en clair dans localStorage → import non-extractible en IndexedDB,
 * puis réécriture du localStorage SANS matériel privé.
 */
export async function loadIdentity(): Promise<StoredIdentity | null> {
  if (typeof window === "undefined") return null;

  // ── migration legacy (F-06) : détruire les JWK en clair si présentes ──
  const raw = localStorage.getItem(LS_IDENTITY);
  if (raw && raw.includes("signPrivJwk")) {
    try {
      const legacy = JSON.parse(raw) as LegacyStoredIdentity;
      if (legacy.signPrivJwk && legacy.ecdhPrivJwk) {
        const bundle = await importLegacyKeyBundle(legacy.signPrivJwk, legacy.ecdhPrivJwk);
        await putSecureKeys(bundle);
        const metaOnly: StoredIdentityMeta = {
          pubkey: bundle.pubkey,
          ecdhPub: bundle.ecdhPub,
          nickname: legacy.nickname || defaultNickname(bundle.pubkey),
          bio: legacy.bio,
        };
        localStorage.setItem(LS_IDENTITY, JSON.stringify(metaOnly));
      } else {
        localStorage.removeItem(LS_IDENTITY); // legacy corrompu → repartir propre
      }
    } catch {
      localStorage.removeItem(LS_IDENTITY); // legacy illisible → repartir propre
    }
  }

  const meta = loadIdentityMeta();
  const keys = await getSecureKeys();

  if (keys && (!meta || keys.pubkey !== meta.pubkey)) {
    // clés sans métadonnées (ou divergence) → les clés font foi, on reconstruit
    const rebuilt: StoredIdentityMeta = {
      pubkey: keys.pubkey,
      ecdhPub: keys.ecdhPub,
      nickname: meta?.nickname && meta.pubkey === keys.pubkey
        ? meta.nickname
        : defaultNickname(keys.pubkey),
      bio: meta?.pubkey === keys.pubkey ? meta.bio : undefined,
    };
    try {
      localStorage.setItem(LS_IDENTITY, JSON.stringify(rebuilt));
    } catch {
      /* quota : l'identité reste utilisable en mémoire */
    }
    return { ...rebuilt, signPriv: keys.signPriv, ecdhPriv: keys.ecdhPriv };
  }

  if (keys && meta) {
    return { ...meta, signPriv: keys.signPriv, ecdhPriv: keys.ecdhPriv };
  }

  return null; // pas de clés → onboarding (les métadonnées orphelines seront écrasées)
}

/** Persiste identité complète : clés privées en IndexedDB, public en LS. */
export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  await putSecureKeys(identity);
  const metaOnly: StoredIdentityMeta = {
    pubkey: identity.pubkey,
    ecdhPub: identity.ecdhPub,
    nickname: identity.nickname,
    bio: identity.bio,
  };
  localStorage.setItem(LS_IDENTITY, JSON.stringify(metaOnly));
}

// ---------- panic wipe (F-11 : complet, aligné sur la promesse UI) ----------

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve(); // best effort : on part quand même
      req.onblocked = () => resolve(); // un autre onglet — la base sera purgée à sa fermeture
    } catch {
      resolve();
    }
  });
}

/**
 * Panic wipe : « Clés, file locale et état local détruits » — la promesse est
 * désormais tenue (F-11) :
 *  - identité : LS + coffre IndexedDB `mbote-secure` ;
 *  - outbox sociale (LS, F-31 : purge par pruneOutbox) ;
 *  - outbox durable binaire : IndexedDB `mbote-outbox` + repli LS
 *    `mbote.outbox.packets.v1` ;
 *  - mode mesh forcé + thème (état local).
 */
export async function panicWipe(): Promise<void> {
  if (typeof window === "undefined") return;
  localStorage.removeItem(LS_IDENTITY);
  localStorage.removeItem(LS_OUTBOX);
  localStorage.removeItem(LS_FORCE_OFFLINE);
  localStorage.removeItem("theme"); // next-themes (storageKey par défaut)
  localStorage.removeItem("mbote.outbox.packets.v1"); // repli LS de l'outbox binaire
  // Ordre important (F-11) : purge du record AVANT la suppression des bases —
  // clearSecureKeys ré-ouvrirait sinon la base juste après deleteDatabase.
  await clearSecureKeys();
  await Promise.all([deleteDb("mbote-secure"), deleteDb("mbote-outbox")]);
}

// ---------- outbox (file d'attente "courrier" hors-ligne) ----------

export type OutboxItem =
  | { id: string; type: "identity"; payload: Record<string, unknown>; queuedAt: number }
  | { id: string; type: "post"; payload: Record<string, unknown>; queuedAt: number }
  | { id: string; type: "like"; payload: Record<string, unknown>; queuedAt: number }
  | { id: string; type: "dm"; payload: Record<string, unknown>; queuedAt: number };

/**
 * F-31 : purge d'alignement — supprime les enveloppes expirées (preuve > 7 j,
 * rejetée d'office par le serveur) et applique le plafond FIFO. Retourne la
 * liste assainie. Appelé à chaque chargement/enfilement/flush.
 */
export function pruneOutbox(items: OutboxItem[]): OutboxItem[] {
  const now = Date.now();
  const fresh = items.filter((i) => now - i.queuedAt <= SOCIAL_OUTBOX_MAX_AGE_MS);
  const overflow = fresh.length - SOCIAL_OUTBOX_MAX_ITEMS;
  return overflow > 0 ? fresh.slice(overflow) : fresh;
}

export function loadOutbox(): OutboxItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_OUTBOX);
    const items = raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    const pruned = pruneOutbox(items);
    if (pruned.length !== items.length) saveOutbox(pruned); // purge persistée
    return pruned;
  } catch {
    return [];
  }
}

export function saveOutbox(items: OutboxItem[]): void {
  localStorage.setItem(LS_OUTBOX, JSON.stringify(pruneOutbox(items)));
}

export function enqueueOutbox(item: Omit<OutboxItem, "id" | "queuedAt">): OutboxItem[] {
  const items = loadOutbox();
  const full: OutboxItem = {
    ...item,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: Date.now(),
  } as OutboxItem;
  items.push(full);
  const pruned = pruneOutbox(items);
  saveOutbox(pruned);
  return pruned;
}

export function removeOutbox(id: string): OutboxItem[] {
  const items = loadOutbox().filter((i) => i.id !== id);
  saveOutbox(items);
  return items;
}

export function loadForceOffline(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LS_FORCE_OFFLINE) === "1";
}

export function saveForceOffline(v: boolean): void {
  if (v) localStorage.setItem(LS_FORCE_OFFLINE, "1");
  else localStorage.removeItem(LS_FORCE_OFFLINE);
}
