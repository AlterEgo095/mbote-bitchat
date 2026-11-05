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
import { NextResponse, type NextRequest } from "next/server";
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

// ───────────────────────── Auth admin (provisoire) ─────────────────────────

/** Clé fournie par la requête : `x-admin-key` ou `Authorization: Bearer …`. */
export function adminKeyFromRequest(req: NextRequest): string | null {
  const direct = req.headers.get("x-admin-key");
  if (direct && direct.length > 0) return direct;
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
}

/** Comparaison sans fuite temporelle : on compare des SHA-256 (longueur fixe). */
export function isAdminKey(provided: string | null | undefined): boolean {
  const expected = process.env.ADMIN_API_KEY ?? "";
  if (!expected || !provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Garde des endpoints admin — 403 uniforme (absente OU invalide). */
export function adminGuard(req: NextRequest): NextResponse | null {
  if (!isAdminKey(adminKeyFromRequest(req))) {
    return NextResponse.json(
      { error: "Accès modération refusé (admin requis)" },
      { status: 403 }
    );
  }
  return null;
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
 * signalements clôturés). Utilisée par l'endpoint admin ET par le tooling CLI
 * (`scripts/moderation-purge.ts`) — une seule définition = un seul comportement
 * d'audit.
 *
 * Le compteur dénormalisé du parent (D5) est décrémenté si on purge une réponse.
 */
export async function purgePostWithAudit(
  tx: Prisma.TransactionClient,
  params: {
    postId: string;
    adminKey: string;
    reason?: string | null;
    /** identité admin telle qu'enregistrée dans la trace (ex. "ops:cli") */
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
      data: { status: "actioned", handledAt: new Date(), handledBy: params.adminKey },
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
      adminKey: params.adminKey,
      action: "purge",
      targetKind: "post",
      targetId: post.id,
      reason: params.reason ?? null,
      reportIds: JSON.stringify(openReports.map((r) => r.id)),
      meta: JSON.stringify(meta),
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
