import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/posts/[id] — détail complet d'un contenu public
 *  (back-office 2026-11 : « toutes les informations disponibles »)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Réponse : contenu INTÉGRAL + auteur (identité publique + statut de compte)
 *  + parent si réponse + réponses (50 max, chronologiques) + TOUS les
 *  signalements (ouverts ET traités) + historique de modération
 *  (ModerationAction) sur ce contenu.
 *
 *  PÉRIMÈTRE STRICT : contenu du FIL PUBLIC (Post) — serveur-visible par
 *  définition. 404 si la ligne n'existe plus (purgée — les traces restent
 *  dans ModerationAction/AdminAudit, visibles via /audit). AUCUN contenu DM
 *  ou groupe MLS : E2EE par conception (invariant §1.4 ADMIN-RBAC.md).
 *
 *  AUTH : requireAdmin({minRole:"support"}) — lecture ; l'auditor reste
 *  STRICT (403). GET → pas de CSRF.
 *
 *  Les actions (hide/unhide/purge) ne vivent PAS ici : elles passent par
 *  /api/moderation/action (justification §6, RBAC par action, réputation D2,
 *  audit transactionnel) et la purge irréversible par four-eyes (É9,
 *  PendingAction purge_post) — une seule définition de chaque sémantique.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const REPLIES_LIMIT = 50;
const MOD_HISTORY_LIMIT = 20;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.posts.detail");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const { id } = await params;
    if (!id || id.length === 0 || id.length > 128) {
      return NextResponse.json({ error: "id invalide" }, { status: 400 });
    }

    const post = await db.post.findUnique({
      where: { id },
      select: {
        id: true,
        content: true,
        geohash: true,
        precision: true,
        parentId: true,
        origin: true,
        meshHops: true,
        likeCount: true,
        replyCount: true,
        hiddenAt: true,
        hiddenById: true,
        createdAt: true,
        signature: true,
        author: {
          select: {
            pubkey: true,
            nickname: true,
            createdAt: true,
            suspendedAt: true,
            suspendedUntil: true,
            bannedAt: true,
            reputationScore: true,
            flaggedCount: true,
          },
        },
        parent: {
          select: {
            id: true,
            content: true,
            hiddenAt: true,
            createdAt: true,
            author: { select: { pubkey: true, nickname: true } },
          },
        },
      },
    }).catch(() => null);

    if (!post) {
      return NextResponse.json(
        { error: "Contenu introuvable (ou purgé — voir l'audit)" },
        { status: 404 }
      );
    }

    const reports = await db.report.findMany({
      where: { targetKind: { in: ["post", "comment"] }, targetId: id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        reporterKey: true,
        reason: true,
        details: true,
        status: true,
        createdAt: true,
        handledAt: true,
      },
    });
    const openReports = reports.filter((r) => r.status === "open").length;

    const replies = await db.post.findMany({
      where: { parentId: id },
      orderBy: { createdAt: "asc" },
      take: REPLIES_LIMIT,
      select: {
        id: true,
        content: true,
        createdAt: true,
        hiddenAt: true,
        author: { select: { pubkey: true, nickname: true } },
      },
    });

    const moderationActions = await db.moderationAction.findMany({
      where: { targetKind: "post", targetId: id },
      orderBy: { createdAt: "desc" },
      take: MOD_HISTORY_LIMIT,
      select: {
        id: true,
        action: true,
        actorLabel: true,
        reason: true,
        meta: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      post: {
        id: post.id,
        content: post.content,
        geohash: post.geohash,
        precision: post.precision,
        parentId: post.parentId,
        origin: post.origin,
        meshHops: post.meshHops,
        likeCount: post.likeCount,
        replyCount: post.replyCount,
        hiddenAt: post.hiddenAt,
        hiddenById: post.hiddenById,
        createdAt: post.createdAt,
        hasSignature: post.signature !== null,
      },
      author: post.author,
      parent: post.parent,
      reports,
      openReports,
      replies,
      moderationActions,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/posts/[id]", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
