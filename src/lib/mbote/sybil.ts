/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  sybil — Sybil phase 0 : preuve de travail + réputation + plafonds de débit
 *  (directive 2026-11-13, matrice L3 SYBIL-RESISTANCE-MATRIX.md phase 0)
 * ─────────────────────────────────────────────────────────────────────────────
 *  MODULE PUR ET ISOMORPHE (client + serveur) — aucune dépendance node.
 *  Les helpers serveur (node:crypto, Prisma) vivent dans sybil-server.ts.
 *
 *  MENACE : la création de comptes serveur est GRATUITE (paire de clés = 1 ms).
 *  Un adversaire forge des milliers d'identités pour (a) saturer les plafonds
 *  de modération, (b) gonfler like/follow, (c) spammer le fil public. La barrière
 *  phase 0 = coût CPU par identité (PoW 20 bits ≈ 2-5 s mobile bas de gamme) +
 *  réputation qui verrouille les plafonds des mauvais acteurs + rate-limit
 *  durci 3 créations/heure/IP.
 *
 *  T0 HORS-LIGNE PRÉSERVÉ (contrainte RDC non négociable) : le PoW n'est exigé
 *  QUE par POST /api/identity (création de compte SERVEUR). Un utilisateur
 *  mesh-only publie/signe hors-ligne sans PoW ni plafond ; la publication
 *  locale reste instantanée (le PoW tourne en Web Worker, non bloquant, et
 *  son échec n'empêche jamais la création locale ni la file courrier/outbox).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Difficulté PoW : 20 bits zéros initiaux ≈ 2^19 itérations en moyenne. */
export const POW_DIFFICULTY_BITS = 20;

/** Nonce : compteur décimal sérialisé — borné anti-DoS parsing. */
export const POW_NONCE_MAX_LENGTH = 64;

/** Chaîne canonique du challenge PoW — même forme que les autres preuves
 *  (proof.ts) : champs séparés par `|`, publiés dans CRYPTO-SPEC-v1. */
export function powChallengeMessage(pubkey: string, ts: number): string {
  return `${pubkey}|pow|${ts}`;
}

/** Le digest hexadécimal commence-t-il par au moins `bits` bits à zéro ? */
export function hashMeetsDifficultyHex(hex: string, bits: number): boolean {
  if (bits <= 0) return true;
  let remaining = bits;
  for (let i = 0; i < hex.length && remaining > 0; i++) {
    const nibble = parseInt(hex[i], 16);
    if (Number.isNaN(nibble)) return false;
    if (nibble === 0) {
      remaining -= 4;
      continue;
    }
    // nibble ≠ 0 : les zéros initiaux du nibble (4, 3, 2, 1 ou 0)
    let zeros = 0;
    for (let b = 3; b >= 0; b--) {
      if ((nibble >> b) & 1) break;
      zeros++;
    }
    return zeros >= remaining;
  }
  return remaining <= 0;
}

/** Vérification des bornes du nonce reçu (anti-DoS avant tout calcul). */
export function isPlausibleNonce(nonce: unknown): nonce is string {
  return (
    typeof nonce === "string" &&
    nonce.length > 0 &&
    nonce.length <= POW_NONCE_MAX_LENGTH &&
    /^[0-9]+$/.test(nonce)
  );
}

// ── Réputation → plafonds de débit quotidiens ────────────────────────────────

/** Matrice des plafonds (directive D2, non négociable) :
 *  score < 0   : 3 posts/j,   10 DMs/j
 *  score 0-9   : 10 posts/j,  50 DMs/j
 *  score 10-99 : 50 posts/j,  200 DMs/j
 *  score ≥ 100 : 200 posts/j, pas de plafond DM (Infinity, borné à l'UI).
 */
export interface DailyLimits {
  posts: number;
  dms: number; // Infinity = pas de plafond DM
}

export function dailyLimits(reputationScore: number): DailyLimits {
  if (!Number.isFinite(reputationScore)) return { posts: 3, dms: 10 };
  if (reputationScore < 0) return { posts: 3, dms: 10 };
  if (reputationScore < 10) return { posts: 10, dms: 50 };
  if (reputationScore < 100) return { posts: 50, dms: 200 };
  return { posts: 200, dms: Infinity };
}

/** Message utilisateur quand un plafond est atteint (directive : message clair,
 *  pas une punition — la réputation augmente avec la participation de qualité). */
export const POSTS_LIMIT_MESSAGE =
  "Vous avez atteint votre limite de posts pour aujourd'hui. Le score de réputation augmente avec la participation de qualité.";
export const DMS_LIMIT_MESSAGE =
  "Vous avez atteint votre limite de messages privés pour aujourd'hui. Le score de réputation augmente avec la participation de qualité.";

/** Jour UTC courant au format "YYYY-MM-DD" — bornes des compteurs dénormalisés
 *  (reset paresseux à minuit UTC, aucun cron). */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Nombre de secondes jusqu'au prochain minuit UTC (Retry-After du 429). */
export function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** Entrée minimale du compteur d'un utilisateur (champs D2 du schéma). */
export interface UsageCounterRow {
  reputationScore: number;
  postsToday: number;
  dmsToday: number;
  usageDay: string | null;
}

/** Verdict de quota — PUR : déterminant pour posts (kind="posts") et DMs
 *  (kind="dms"). Le reset paresseux est CALCULÉ ici (valeur fraîche du
 *  compteur si usageDay ≠ jour UTC courant) mais ÉCRIT par l'appelant
 *  (sybil-server.ts) dans la même écriture que l'incrément. */
export interface QuotaVerdict {
  allowed: boolean;
  limit: number;
  used: number; // valeur courante APRÈS reset paresseux calculé
  remaining: number;
  retryAfterSeconds: number | null; // null si autorisé
  /** Le reset paresseux doit-il être persisté (usageDay obsolète) ? */
  needsDayReset: boolean;
  usageDay: string;
}

export function quotaVerdict(
  row: UsageCounterRow,
  kind: "posts" | "dms",
  now: Date
): QuotaVerdict {
  const today = utcDay(now);
  const needsDayReset = row.usageDay !== today;
  const used = needsDayReset ? 0 : kind === "posts" ? row.postsToday : row.dmsToday;
  const limit = dailyLimits(row.reputationScore)[kind];
  const remaining = Number.isFinite(limit) ? Math.max(0, limit - used) : Number.POSITIVE_INFINITY;
  const allowed = !Number.isFinite(limit) || used < limit;
  return {
    allowed,
    limit,
    used,
    remaining,
    retryAfterSeconds: allowed ? null : secondsUntilUtcMidnight(now),
    needsDayReset,
    usageDay: today,
  };
}

// ── Tiers de réputation (badge UI) ───────────────────────────────────────────

export type ReputationTier = "negative" | "neutral" | "established" | "exemplary";

export function reputationTier(reputationScore: number): ReputationTier {
  if (!Number.isFinite(reputationScore) || reputationScore < 0) return "negative";
  if (reputationScore < 10) return "neutral";
  if (reputationScore < 100) return "established";
  return "exemplary";
}

export const REPUTATION_TIER_LABEL: Record<ReputationTier, string> = {
  negative: "Réputation à reconstruire",
  neutral: "Réputation neutre",
  established: "Réputation établie",
  exemplary: "Réputation exemplaire",
};
