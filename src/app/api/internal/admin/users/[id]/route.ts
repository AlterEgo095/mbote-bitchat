import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { auditSnippet } from "@/lib/mbote/moderation";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/users/[id] — fiche utilisateur (ADM Étape 7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 7. [id] = PUBKEY (arbitrage §13.2 — identité publique
 *  stable, cible des traces ModerationAction/AdminAudit).
 *
 *  PÉRIMÈTRE STRICT (directive) : AUCUNE donnée privée — pas d'email (le
 *  modèle User n'en a AUCUN par conception — identité = paire de clés),
 *  pas d'IP, pas de DM, pas d'historique de messages. Tout ce qui est servi
 *  est PUBLIC ou opératoire : pseudo, bio, date d'inscription, statut de
 *  suspension (dates), compteurs, actions admin historisées, reports ouverts.
 *
 *  HISTORIQUE : AdminAudit filtré targetType='user' AND targetId=<pubkey>
 *  (le format écrit par /api/moderation/action depuis l'Étape 0 ET par les
 *  endpoints E7 — lecture des 20 dernières, total inclus).
 *
 *  REPORTS REÇUS : reports OUVERTS sur les posts de l'utilisateur (lien vers
 *  la queue du panneau pour traitement) — 10 derniers + total.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const AUDIT_LIMIT = 20;
const REPORTS_LIMIT = 10;
const SNIPPET_LEN = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.users.detail");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const { id } = await params;
    if (!id || id.length === 0 || id.length > 200) {
      return NextResponse.json({ error: "id invalide" }, { status: 400 });
    }

    const user = await db.user.findUnique({
      where: { pubkey: id },
      select: {
        id: true,
        pubkey: true, nickname: true, bio: true, createdAt: true,
        suspendedAt: true, suspendedUntil: true,
        _count: { select: { posts: true, warnings: true } },
      },
    });
    if (!user) {
      return NextResponse.json({ error: "Utilisateur introuvable" }, { status: 404 });
    }

    const now = Date.now();
    const suspendedActive =
      user.suspendedAt !== null &&
      (user.suspendedUntil === null || user.suspendedUntil.getTime() > now);

    const openTotalRow = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM Report r
       JOIN Post p ON p.id = r.targetId
       WHERE p.authorId = ? AND r.status = 'open'`,
      user.id
    );
    const openReportsRows = await db.$queryRawUnsafe<Array<{
      id: string; reason: string; details: string | null; targetKind: string; targetId: string;
      createdAt: Date; postContent: string | null; postHiddenAt: Date | null;
    }>>(
      `SELECT r.id, r.reason, r.details, r.targetKind, r.targetId, r.createdAt,
              p.content AS postContent, p.hiddenAt AS postHiddenAt
       FROM Report r
       JOIN Post p ON p.id = r.targetId
       WHERE p.authorId = ? AND r.status = 'open'
       ORDER BY r.createdAt ASC
       LIMIT ${REPORTS_LIMIT + 1}`,
      user.id
    );
    const openReportsTotal = Number(openTotalRow[0]?.n ?? 0n);
    const openReportsHasMore = openReportsRows.length > REPORTS_LIMIT;
    const openReportsList = openReportsRows.slice(0, REPORTS_LIMIT);

    const auditTotal = await db.adminAudit.count({
      where: { targetType: "user", targetId: user.pubkey },
    });
    const audit = await db.adminAudit.findMany({
      where: { targetType: "user", targetId: user.pubkey },
      orderBy: { createdAt: "desc" },
      take: AUDIT_LIMIT,
      select: {
        id: true, action: true, actorRole: true, justification: true,
        beforeJson: true, afterJson: true, createdAt: true,
      },
    });

    return NextResponse.json({
      user: {
        pubkey: user.pubkey,
        pseudo: user.nickname,
        bio: user.bio,
        createdAt: user.createdAt,
        status: suspendedActive ? "suspendu" : "actif",
        suspendedAt: user.suspendedAt,
        suspendedUntil: user.suspendedUntil,
      },
      counts: {
        posts: user._count.posts,
        openReports: openReportsTotal,
        warnings: user._count.warnings,
        auditEntries: auditTotal,
      },
      openReports: {
        items: openReportsList.map((r) => ({
          id: r.id,
          reason: r.reason,
          details: r.details,
          targetKind: r.targetKind,
          targetId: r.targetId,
          createdAt: r.createdAt,
          postSnippet: r.postContent ? auditSnippet(r.postContent, SNIPPET_LEN) : null,
          postHiddenAt: r.postHiddenAt,
        })),
        hasMore: openReportsHasMore,
      },
      audit,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/users/[id]", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
