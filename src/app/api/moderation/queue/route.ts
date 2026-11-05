import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { adminGuard, auditSnippet } from "@/lib/mbote/moderation";
import { parseBoundedInt } from "@/lib/mbote/params";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/moderation/queue — file de modération (ADMIN)
 * ─────────────────────────────────────────────────────────────────────────────
 *  AUTH PROVISOIRE (validation A3) : header `x-admin-key: <ADMIN_API_KEY>`
 *  (ou `Authorization: Bearer <ADMIN_API_KEY>`) — clé dans l'env, à remplacer
 *  par un RBAC complet AVANT ouverture publique (documenté dans
 *  docs/proofs/A3-moderation.md). 403 UNIFORME : clé absente ou invalide.
 *
 *  Chaque entrée = un signalement + son CONTEXTE : contenu ciblé (extrait,
 *  auteur, état hidden/suspendu), nb de signalements ouverts sur la même cible.
 *  PÉRIMÈTRE : fil public uniquement — il n'existe AUCUN signalement DM
 *  (impossible par conception : E2EE).
 *
 *  Paramètres : ?status=open|actioned|dismissed|all (défaut open) · ?limit=1..200
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function GET(req: NextRequest) {
  const done = trackApiRequest("moderation.queue");
  try {
    const denied = adminGuard(req);
    if (denied) return denied;

    const sp = req.nextUrl.searchParams;
    const statusRaw = sp.get("status") ?? "open";
    const status =
      statusRaw === "all" || ["open", "actioned", "dismissed"].includes(statusRaw)
        ? statusRaw
        : null;
    if (!status) {
      return NextResponse.json(
        { error: "status invalide (open | actioned | dismissed | all)" },
        { status: 400 }
      );
    }
    const limit = parseBoundedInt(sp.get("limit") ?? "", 1, 200) ?? 100;

    const reports = await db.report.findMany({
      where: status === "all" ? {} : { status },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // contexte des cibles : un seul lot de requêtes pour la page
    const targetIds = [...new Set(reports.map((r) => r.targetId))];
    const targets = await db.post.findMany({
      where: { id: { in: targetIds } },
      select: {
        id: true,
        content: true,
        createdAt: true,
        hiddenAt: true,
        hiddenBy: true,
        author: { select: { pubkey: true, nickname: true, suspendedAt: true } },
      },
    });
    const targetById = new Map(targets.map((t) => [t.id, t]));

    // nb de signalements OUVERTS par cible (le « poids » d'un signalement)
    const openCounts = await db.report.groupBy({
      by: ["targetId"],
      where: { status: "open", targetId: { in: targetIds } },
      _count: { _all: true },
    });
    const openByTarget = new Map(openCounts.map((c) => [c.targetId, c._count._all]));

    const queue = reports.map((r) => {
      const t = targetById.get(r.targetId);
      return {
        report: {
          id: r.id,
          reporterKey: r.reporterKey,
          targetKind: r.targetKind,
          targetId: r.targetId,
          reason: r.reason,
          details: r.details,
          status: r.status,
          handledAt: r.handledAt,
          handledBy: r.handledBy,
          createdAt: r.createdAt,
        },
        context: t
          ? {
              exists: true,
              snippet: auditSnippet(t.content, 160),
              postCreatedAt: t.createdAt,
              hiddenAt: t.hiddenAt,
              hiddenBy: t.hiddenBy,
              author: {
                pubkey: t.author.pubkey,
                nickname: t.author.nickname,
                suspendedAt: t.author.suspendedAt,
              },
            }
          : {
              // absent de Post = purgé (ou inconsistence) — l'audit des purges
              // vit dans ModerationAction (trace conservée par conception)
              exists: false,
              note: "contenu absent de la DB (purgé) — voir ModerationAction action=purge",
            },
        openReportsOnTarget: openByTarget.get(r.targetId) ?? 0,
      };
    });

    const openTotal = await db.report.count({ where: { status: "open" } });
    return NextResponse.json({ queue, openTotal });
  } catch (e) {
    console.error("GET /api/moderation/queue", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
