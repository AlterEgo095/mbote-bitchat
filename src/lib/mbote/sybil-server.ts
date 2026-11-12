/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  sybil-server — helpers SERVEUR de la phase 0 Sybil (D2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Complément de sybil.ts (pur/isomorphe) : vérification PoW (node:crypto —
 *  SHA-256 natif, ~1 M hash/s sous bun), sweep de réputation paresseux
 *  (posts > 24 h sans report) et application des compteurs de quota.
 *  JAMAIS importé côté client (node:crypto casserait le bundle).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import {
  hashMeetsDifficultyHex,
  isPlausibleNonce,
  powChallengeMessage,
  POW_DIFFICULTY_BITS,
  type QuotaVerdict,
  type UsageCounterRow,
} from "./sybil";

// ── PoW — vérification serveur ───────────────────────────────────────────────

export interface PowVerifyInput {
  pubkey: string;
  ts: unknown; // même horodatage que la preuve de possession ECDSA
  nonce: unknown;
}

export interface PowVerifyResult {
  valid: boolean;
  reason?: string;
  challenge?: string;
}

/**
 * Vérifie un PoW de création : challenge = `${pubkey}|pow|${ts}`, nonce
 * décimal tel que SHA-256(`${challenge}:${nonce}`) commence par 20 bits à
 * zéro. La difficulté est décidée PAR LE SERVEUR (la valeur annoncée par le
 * client est ignorée — anti-triche). Sans fenêtre de fraîcheur sur `ts` :
 * la file courrier/outbox T0 peut rejouer une création signée plusieurs
 * heures après son calcul hors-ligne (tolérance 7 j côté signature) — la
 * défense contre le rejeu est la table PowSpent (consommation unique),
 * pas l'horloge.
 */
export function verifyPowServer(input: PowVerifyInput): PowVerifyResult {
  const { pubkey, ts, nonce } = input;
  if (!isPlausibleNonce(nonce)) {
    return { valid: false, reason: "nonce PoW invalide (entier décimal attendu)" };
  }
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts <= 0) {
    return { valid: false, reason: "horodatage PoW invalide" };
  }
  const challenge = powChallengeMessage(pubkey, ts);
  const digest = createHash("sha256")
    .update(`${challenge}:${nonce}`)
    .digest("hex");
  if (!hashMeetsDifficultyHex(digest, POW_DIFFICULTY_BITS)) {
    return { valid: false, reason: "preuve de travail insuffisante (20 bits attendus)", challenge };
  }
  return { valid: true, challenge };
}

/**
 * Consomme le challenge (anti-rejeu GLOBAL, table PowSpent). Retourne false
 * si le challenge a DÉJÀ été consommé → 409 au rejeu exact.
 */
export async function consumePowChallenge(challenge: string): Promise<boolean> {
  try {
    await db.powSpent.create({ data: { challenge } });
    return true;
  } catch {
    // P2002 (PK dupliquée) ou toute erreur d'écriture → fail-closed
    return false;
  }
}

// ── Sweep de réputation paresseux ────────────────────────────────────────────

/** Milisecondes après lesquelles un post non signalé vaut +1 de réputation. */
const POST_REPUTATION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * +1 de réputation par post de `authorId` publié il y a PLUS DE 24 h sans
 * report open/actioned, crédité une seule fois (Post.reputationRewarded). Appelé
 * paresseusement aux points d'application (POST /api/posts, GET profil) —
 * jamais de cron (pattern É6). Retourne le score APRÈS crédit.
 */
export async function sweepPostReputation(authorId: string): Promise<number> {
  const cutoff = new Date(Date.now() - POST_REPUTATION_AGE_MS);
  // Borné : le sweep ne peut pas exploser sur un profil prolifique (le reste
  // sera crédité aux appels suivants — pas de cron, pattern É6).
  const candidates = await db.post.findMany({
    where: { authorId, reputationRewarded: false, createdAt: { lt: cutoff } },
    select: { id: true },
    take: 200,
  });
  if (candidates.length === 0) {
    const row = await db.user.findUnique({
      where: { id: authorId },
      select: { reputationScore: true },
    });
    return row?.reputationScore ?? 0;
  }
  // Report.targetId est une chaîne brute (pas de relation Prisma) : le filtre
  // « sans report OUVERT » se fait par exclusion des cibles signalées. Un
  // report DISMISSÉ ne bloque pas le crédit (fausse alarme — arbitrage
  // ADMIN-RBAC §12.12) ; un report open OU actioned (hide/ban) le bloque
  // (le contenu a été jugé, et le hide a déjà coûté −5).
  const blockedTargets = await db.report.findMany({
    where: {
      targetKind: { in: ["post", "comment"] },
      targetId: { in: candidates.map((c) => c.id) },
      status: { in: ["open", "actioned"] },
    },
    select: { targetId: true },
  });
  const blocked = new Set(blockedTargets.map((r) => r.targetId));
  const clean = candidates.filter((c) => !blocked.has(c.id));
  if (clean.length === 0) {
    const row = await db.user.findUnique({
      where: { id: authorId },
      select: { reputationScore: true },
    });
    return row?.reputationScore ?? 0;
  }
  const credited = await db.$transaction(async (tx) => {
    await tx.post.updateMany({
      where: { id: { in: clean.map((p) => p.id) } },
      data: { reputationRewarded: true },
    });
    return tx.user.update({
      where: { id: authorId },
      data: { reputationScore: { increment: clean.length } },
      select: { reputationScore: true },
    });
  });
  return credited.reputationScore;
}

// ── Quota quotidien — écriture du compteur ───────────────────────────────────

/**
 * Applique le verdict de quota : reset paresseux du jour si besoin + incrément
 * du compteur. À appeler APRÈS la création réussie (post/DM) — le compteur ne
 * compte jamais les tentatives refusées (sinon un 429 prolonge le blocage).
 * `tx` : client de transaction Prisma (l'appelant peut l'inclure dans SA
 * transaction — sinon l'écriture part sur le client global).
 */
export type PrismaTx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export async function commitUsageIncrement(
  userId: string,
  verdict: QuotaVerdict,
  kind: "posts" | "dms",
  tx?: PrismaTx
): Promise<void> {
  const client = tx ?? db;
  const counter = kind === "posts" ? "postsToday" : "dmsToday";
  await client.user.update({
    where: { id: userId },
    data: {
      usageDay: verdict.usageDay,
      ...(verdict.needsDayReset
        ? { postsToday: kind === "posts" ? 1 : 0, dmsToday: kind === "dms" ? 1 : 0 }
        : { [counter]: { increment: 1 } }),
    },
  });
}

/** Lecture normale des compteurs d'un utilisateur pour l'évaluation de quota. */
export async function readUsageRow(userId: string): Promise<UsageCounterRow | null> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: {
      reputationScore: true,
      postsToday: true,
      dmsToday: true,
      usageDay: true,
    },
  });
  return row;
}
