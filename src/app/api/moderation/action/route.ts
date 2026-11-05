import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import {
  MODERATION_ACTIONS,
  adminGuard,
  adminKeyFromRequest,
  purgePostWithAudit,
} from "@/lib/mbote/moderation";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/moderation/action — action admin sur le fil public
 * ─────────────────────────────────────────────────────────────────────────────
 *  AUTH PROVISOIRE : header `x-admin-key` (ADMIN_API_KEY) — 403 UNIFORME si
 *  absente/invalide (test négatif exigé : un utilisateur non admin → 403).
 *  À remplacer par un RBAC complet avant ouverture publique.
 *
 *  Actions (fil public UNIQUEMENT — AUCUNE modération DM, E2EE par conception) :
 *   - hide      (post)   : masqué — DISPARAÎT du fil public, RESTE en DB (audit)
 *   - unhide    (post)   : retour au fil public
 *   - purge     (post)   : SUPPRIMÉ en DB (cascade likes/réponses) — trace
 *                          d'audit conservée dans ModerationAction (auteur,
 *                          extrait ≤ 280, compteurs, signalements clôturés)
 *   - warn      (user)   : avertissement enregistré (audit) — la notification
 *                          à l'utilisateur est hors périmètre A3
 *   - suspend   (user)   : posts absents du fil public + publication refusée 403
 *   - unsuspend (user)   : levée de suspension
 *
 *  Chaque action clôture les signalements ouverts liés (status=actioned,
 *  handledAt, handledBy) et laisse UNE trace ModerationAction.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("moderation.action");
  try {
    const denied = adminGuard(req);
    if (denied) return denied;
    const adminKey = adminKeyFromRequest(req) as string; // guard validé non-null

    const body = await req.json().catch(() => null);
    const { action, targetKind, targetId, reason } = (body ?? {}) as Record<string, unknown>;

    if (typeof action !== "string" || !(MODERATION_ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json(
        { error: `action invalide (valeurs : ${MODERATION_ACTIONS.join(", ")})` },
        { status: 400 }
      );
    }
    if (targetKind !== "post" && targetKind !== "user") {
      return NextResponse.json(
        { error: "targetKind invalide (\"post\" | \"user\") — aucune modération DM (E2EE par conception)" },
        { status: 400 }
      );
    }
    if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > 128) {
      return NextResponse.json({ error: "targetId invalide" }, { status: 400 });
    }
    if (reason != null && (typeof reason !== "string" || reason.length > 500)) {
      return NextResponse.json({ error: "reason invalide (≤ 500 caractères)" }, { status: 400 });
    }

    const handledAt = new Date();

    // ── actions sur un contenu public ──
    if (targetKind === "post") {
      if (!["hide", "unhide", "purge"].includes(action)) {
        return NextResponse.json(
          { error: `action "${action}" s'applique à un user, pas à un post` },
          { status: 400 }
        );
      }
      const post = await db.post.findUnique({
        where: { id: targetId },
        select: { id: true, parentId: true },
      });
      if (!post) {
        return NextResponse.json(
          { error: "Post introuvable (ou déjà purgé — voir ModerationAction)" },
          { status: 404 }
        );
      }

      if (action === "hide") {
        const openReports = await db.report.findMany({
          where: { targetKind: { in: ["post", "comment"] }, targetId, status: "open" },
          select: { id: true },
        });
        const updated = await db.$transaction(async (tx) => {
          const row = await tx.post.update({
            where: { id: targetId },
            data: { hiddenAt: handledAt, hiddenBy: adminKey },
            select: { id: true, hiddenAt: true, hiddenBy: true },
          });
          if (openReports.length > 0) {
            await tx.report.updateMany({
              where: { id: { in: openReports.map((r) => r.id) } },
              data: { status: "actioned", handledAt, handledBy: adminKey },
            });
          }
          const trace = await tx.moderationAction.create({
            data: {
              adminKey,
              action: "hide",
              targetKind: "post",
              targetId,
              reason: typeof reason === "string" ? reason : null,
              reportIds: JSON.stringify(openReports.map((r) => r.id)),
            },
          });
          return { row, trace, closed: openReports.map((r) => r.id) };
        });
        return NextResponse.json({
          action: updated.trace,
          affected: {
            post: { id: targetId, hiddenAt: updated.row.hiddenAt, hiddenBy: updated.row.hiddenBy },
            reportsClosed: updated.closed.length,
          },
        });
      }

      if (action === "unhide") {
        const updated = await db.$transaction(async (tx) => {
          const row = await tx.post.update({
            where: { id: targetId },
            data: { hiddenAt: null, hiddenBy: null },
            select: { id: true, hiddenAt: true },
          });
          const trace = await tx.moderationAction.create({
            data: {
              adminKey,
              action: "unhide",
              targetKind: "post",
              targetId,
              reason: typeof reason === "string" ? reason : null,
            },
          });
          return { row, trace };
        });
        return NextResponse.json({
          action: updated.trace,
          affected: { post: { id: targetId, hiddenAt: updated.row.hiddenAt } },
        });
      }

      // purge — trace d'audit OBLIGATOIRE (post supprimé, trace conservée)
      try {
        const outcome = await db.$transaction((tx) =>
          purgePostWithAudit(tx, {
            postId: targetId,
            adminKey,
            reason: typeof reason === "string" ? reason : null,
          })
        );
        return NextResponse.json({
          action: { action: "purge", targetKind: "post", targetId, adminKey },
          affected: {
            purged: true,
            purgedPostId: outcome.purgedPostId,
            author: { pubkey: outcome.authorKey, nickname: outcome.authorNickname },
            snippet: outcome.snippet,
            repliesPurged: outcome.repliesPurged,
            reportsClosed: outcome.reportsClosed.length,
          },
        });
      } catch (err) {
        if (err instanceof Error && err.message === "POST_NOT_FOUND") {
          return NextResponse.json({ error: "Post introuvable (ou déjà purgé)" }, { status: 404 });
        }
        throw err;
      }
    }

    // ── actions sur un utilisateur ──
    if (!["warn", "suspend", "unsuspend"].includes(action)) {
      return NextResponse.json(
        { error: `action "${action}" s'applique à un post, pas à un user` },
        { status: 400 }
      );
    }
    const user = await db.user.findUnique({
      where: { pubkey: targetId },
      select: { id: true, pubkey: true, nickname: true, suspendedAt: true },
    });
    if (!user) {
      return NextResponse.json({ error: "Utilisateur introuvable" }, { status: 404 });
    }

    // signalements ouverts sur les posts de cet utilisateur (clôture au passage)
    const userPostIds = (
      await db.post.findMany({ where: { authorId: user.id }, select: { id: true } })
    ).map((p) => p.id);
    const openReports = await db.report.findMany({
      where: { targetKind: { in: ["post", "comment"] }, targetId: { in: userPostIds }, status: "open" },
      select: { id: true },
    });

    const result = await db.$transaction(async (tx) => {
      const data =
        action === "suspend"
          ? { suspendedAt: handledAt, suspendedBy: adminKey }
          : action === "unsuspend"
            ? { suspendedAt: null, suspendedBy: null }
            : {};
      const row = await tx.user.update({
        where: { id: user.id },
        data,
        select: { pubkey: true, suspendedAt: true },
      });
      if (openReports.length > 0) {
        await tx.report.updateMany({
          where: { id: { in: openReports.map((r) => r.id) } },
          data: { status: "actioned", handledAt, handledBy: adminKey },
        });
      }
      const trace = await tx.moderationAction.create({
        data: {
          adminKey,
          action,
          targetKind: "user",
          targetId,
          reason: typeof reason === "string" ? reason : null,
          reportIds: JSON.stringify(openReports.map((r) => r.id)),
          meta: JSON.stringify({
            nickname: user.nickname,
            closedReports: openReports.length,
            ...(action === "warn" ? { note: "avertissement enregistré (notification hors périmètre A3)" } : {}),
          }),
        },
      });
      return { row, trace };
    });

    return NextResponse.json({
      action: result.trace,
      affected: {
        user: { pubkey: result.row.pubkey, suspendedAt: result.row.suspendedAt },
        reportsClosed: openReports.length,
      },
    });
  } catch (e) {
    console.error("POST /api/moderation/action", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
