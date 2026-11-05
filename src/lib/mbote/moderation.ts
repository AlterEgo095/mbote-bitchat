/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  moderation — socle commun A3 (fil public UNIQUEMENT)
 * ─────────────────────────────────────────────────────────────────────────────
 *  PÉRIMÈTRE STRICT (validation A3) :
 *   - modération du fil public uniquement : posts + commentaires publics
 *     (les deux sont des lignes `Post`) ;
 *   - AUCUNE modération DM — impossible par conception : le serveur ne stocke
 *     que du chiffré E2EE (boîte aux lettres aveugle, cf. /api/dms) et ne peut
 *     ni lire ni qualifier un message privé ;
 *   - auth admin PROVISOIRE : clé API dans l'env (`ADMIN_API_KEY`, header
 *     `x-admin-key`) — à remplacer par un RBAC complet AVANT ouverture
 *     publique (documenté dans docs/proofs/A3-moderation.md § « non testé »).
 *
 *  Réponse 403 UNIFORME (clé absente ou invalide) : on ne distingue pas la
 *  présence de la validité — le test négatif exigé est 403 dans les deux cas.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";

// ───────────────────────── Vocabulaire fermé ─────────────────────────

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "violence",
  "illegal",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const MODERATION_ACTIONS = [
  "warn",
  "hide",
  "unhide",
  "suspend",
  "unsuspend",
  "purge",
] as const;
export type ModerationActionName = (typeof MODERATION_ACTIONS)[number];

export const REPORT_TARGET_KINDS = ["post", "comment"] as const;
export type ReportTargetKind = (typeof REPORT_TARGET_KINDS)[number];

// ───────────────────────── Garde CLI (seul usage restant de la clé) ─────────────────────────

/**
 * ADM Étape 0 (rupture) : `ADMIN_API_KEY` n'est PLUS lue par aucun endpoint
 * HTTP. Le seul consommateur restant est le CLI de purge
 * (scripts/moderation-purge.ts) qui valide `--admin-key` contre l'env avec
 * cette comparaison timing-safe. Jamais stockée, jamais renvoyée.
 */
export function isAdminKey(provided: string | null | undefined): boolean {
  const expected = process.env.ADMIN_API_KEY ?? "";
  if (!expected || !provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// ───────────────────────── Helpers d'audit ─────────────────────────

/** Extrait d'audit borné : le contenu purgé disparaît, l'extrait reste. */
export function auditSnippet(content: string, max = 280): string {
  const clean = content.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

// ───────────────────────── Purge transactionnelle ─────────────────────────

export interface PurgeOutcome {
  purgedPostId: string;
  authorKey: string;
  authorNickname: string;
  snippet: string;
  repliesPurged: number;
  likeCount: number;
  reportsClosed: string[];
  parentId: string | null;
}

/**
 * Purge d'un post DANS UNE TRANSACTION : le contenu est supprimé (cascade
 * likes + réponses), la trace d'audit `ModerationAction` est écrite avec le
 * contexte nécessaire à un auditeur (auteur, extrait ≤ 280, compteurs,
 * signalements clôturés) et la ligne `AdminAudit` (identité nominative)
 * est écrite dans la MÊME transaction. Utilisée par l'endpoint admin (session)
 * ET par le tooling CLI (`scripts/moderation-purge.ts`) — une seule définition
 * = un seul comportement d'audit.
 *
 * ADM Étape 0 (rupture) : l'acteur est une IDENTITÉ (AdminUser.id + label),
 * jamais une clé secrète.
 *
 * Le compteur dénormalisé du parent (D5) est décrémenté si on purge une réponse.
 */
export interface PurgeActor {
  adminUserId: number; // id AdminUser (le pseudo-user `system` pour le CLI)
  actorLabel: string; // "admin-<id>" | "cli" — JAMAIS un secret
  actorRole: string; // copie figée du rôle au moment de l'action
  ip?: string | null;
  userAgent?: string | null;
}

export async function purgePostWithAudit(
  tx: Prisma.TransactionClient,
  params: {
    postId: string;
    actor: PurgeActor;
    reason?: string | null;
  }
): Promise<PurgeOutcome> {
  const post = await tx.post.findUnique({
    where: { id: params.postId },
    select: {
      id: true,
      content: true,
      parentId: true,
      likeCount: true,
      author: { select: { pubkey: true, nickname: true } },
    },
  });
  if (!post) throw new Error("POST_NOT_FOUND");

  // signalements ouverts sur la cible → clôturés par l'action
  const openReports = await tx.report.findMany({
    where: { targetKind: { in: ["post", "comment"] }, targetId: post.id, status: "open" },
    select: { id: true },
  });

  const repliesPurged = await tx.post.count({ where: { parentId: post.id } });

  await tx.post.delete({ where: { id: post.id } }); // cascade : likes + réponses

  if (post.parentId) {
    // cohérence du compteur dénormalisé du parent (une réponse de moins)
    await tx.post
      .update({
        where: { id: post.parentId },
        data: { replyCount: { decrement: 1 } },
      })
      .catch(() => undefined); // parent déjà purgé simultanément : rien à faire
  }

  if (openReports.length > 0) {
    await tx.report.updateMany({
      where: { id: { in: openReports.map((r) => r.id) } },
      data: { status: "actioned", handledAt: new Date(), handledById: params.actor.adminUserId },
    });
  }

  const meta = {
    authorKey: post.author.pubkey,
    nickname: post.author.nickname,
    snippet: auditSnippet(post.content),
    repliesPurged,
    likeCount: post.likeCount,
    closedReports: openReports.length,
  };

  await tx.moderationAction.create({
    data: {
      adminUserId: params.actor.adminUserId,
      actorLabel: params.actor.actorLabel,
      action: "purge",
      targetKind: "post",
      targetId: post.id,
      reason: params.reason ?? null,
      reportIds: JSON.stringify(openReports.map((r) => r.id)),
      meta: JSON.stringify(meta),
    },
  });

  // ADM Étape 0 — journal d'audit nominatif (append-only), même transaction
  await tx.adminAudit.create({
    data: {
      actorId: params.actor.adminUserId,
      actorRole: params.actor.actorRole,
      action: "purge",
      targetType: "post",
      targetId: post.id,
      beforeJson: JSON.stringify({
        content: post.content,
        authorPubkey: post.author.pubkey,
        likeCount: post.likeCount,
        repliesPurged,
      }),
      afterJson: JSON.stringify(meta),
      ip: params.actor.ip ?? null,
      userAgent: params.actor.userAgent ?? null,
      justification: params.reason ?? null,
    },
  });

  return {
    purgedPostId: post.id,
    authorKey: post.author.pubkey,
    authorNickname: post.author.nickname,
    snippet: meta.snippet,
    repliesPurged,
    likeCount: post.likeCount,
    reportsClosed: openReports.map((r) => r.id),
    parentId: post.parentId,
  };
}
