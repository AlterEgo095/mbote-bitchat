import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { MODERATION_ACTIONS, purgePostWithAudit } from "@/lib/mbote/moderation";
import { isDenied, requireAdmin, roleAtLeast, writeAdminAudit, type AdminContext } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * Rôles MINIMAUX PAR ACTION — matrice RBAC §4 (ADMIN-RBAC.md) câblée à
 * l'Étape 4 : warn = support · hide/unhide/suspend/unsuspend/purge = moderator.
 * (support et auditor = lecture seule — directive Étape 4.)
 */
const ACTION_MIN_ROLE: Record<string, string> = {
  warn: "support",
  hide: "moderator",
  unhide: "moderator",
  suspend: "moderator",
  unsuspend: "moderator",
  purge: "moderator",
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/moderation/action — action admin sur le fil public
 * ─────────────────────────────────────────────────────────────────────────────
 *  ADM Étape 0 — RUPTURE ADMIN_API_KEY : l'authentification est une SESSION
 *  admin (cookie `mbote_admin_session` + header `x-admin-csrf` sur mutation).
 *  AUCUNE clé n'est lue ici. ADM Étape 4 — DOUBLE CONTRÔLE : la requête doit
 *  AUSSI porter le token interne du panneau (`x-admin-internal`) ET l'acteur
 *  nominatif (`x-admin-actor` == session) — le token SEUL ne peut RIEN faire.
 *  401/403 avec message uniforme `unauthorized` (aucune fuite de couche).
 *  Rôles par action : matrice RBAC §4 (warn=support · autres mutations=moderator).
 *  L'acteur est `AdminUser.id` (traçable) ;
 *  chaque action écrit `ModerationAction` (label `admin-<id>`) ET `AdminAudit`
 *  (append-only) dans la même transaction. Aucune réponse ne contient de secret.
 *
 *  Actions (fil public UNIQUEMENT — AUCUNE modération DM, E2EE par conception) :
 *   - hide      (post)   : masqué — DISPARAÎT du fil public, RESTE en DB (audit)
 *   - unhide    (post)   : retour au fil public
 *   - purge     (post)   : SUPPRIMÉ en DB (cascade likes/réponses) — traces
 *                          ModerationAction + AdminAudit conservées
 *   - warn      (user)   : avertissement enregistré (audit) — la notification
 *                          à l'utilisateur est hors périmètre A3
 *   - suspend   (user)   : posts absents du fil public + publication refusée 403
 *   - unsuspend (user)   : levée de suspension
 *
 *  Chaque action clôture les signalements ouverts liés (status=actioned,
 *  handledById = admin) et laisse UNE trace ModerationAction + UNE AdminAudit.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("moderation.action");
  try {
    const gate = await requireAdmin(req, { minRole: "auditor", mutation: true });
    if (isDenied(gate)) return gate;
    const ctx: AdminContext = gate;

    const body = await req.json().catch(() => null);
    const { action, targetKind, targetId, reason } = (body ?? {}) as Record<string, unknown>;

    if (typeof action !== "string" || !(MODERATION_ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json(
        { error: `action invalide (valeurs : ${MODERATION_ACTIONS.join(", ")})` },
        { status: 400 }
      );
    }
    // RBAC §4 — rôle minimal PAR ACTION (au-delà du plancher auditor du gate)
    if (!roleAtLeast(ctx.role, ACTION_MIN_ROLE[action] ?? "moderator")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 403 });
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
    const actor = {
      adminUserId: ctx.adminUserId,
      actorLabel: ctx.actorLabel,
      actorRole: ctx.role,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };

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
            data: { hiddenAt: handledAt, hiddenById: ctx.adminUserId },
            select: { id: true, hiddenAt: true, hiddenById: true },
          });
          if (openReports.length > 0) {
            await tx.report.updateMany({
              where: { id: { in: openReports.map((r) => r.id) } },
              data: { status: "actioned", handledAt, handledById: ctx.adminUserId },
            });
          }
          const trace = await tx.moderationAction.create({
            data: {
              adminUserId: ctx.adminUserId,
              actorLabel: ctx.actorLabel,
              action: "hide",
              targetKind: "post",
              targetId,
              reason: typeof reason === "string" ? reason : null,
              reportIds: JSON.stringify(openReports.map((r) => r.id)),
            },
          });
          await writeAdminAudit({
            tx,
            actorId: ctx.adminUserId,
            actorRole: ctx.role,
            action: "hide",
            targetType: "post",
            targetId,
            after: { hiddenAt: row.hiddenAt, reportsClosed: openReports.length },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            justification: typeof reason === "string" ? reason : null,
          });
          return { row, trace, closed: openReports.map((r) => r.id) };
        });
        return NextResponse.json({
          action: updated.trace,
          affected: {
            post: { id: targetId, hiddenAt: updated.row.hiddenAt, hiddenById: updated.row.hiddenById },
            reportsClosed: updated.closed.length,
          },
        });
      }

      if (action === "unhide") {
        const updated = await db.$transaction(async (tx) => {
          const row = await tx.post.update({
            where: { id: targetId },
            data: { hiddenAt: null, hiddenById: null },
            select: { id: true, hiddenAt: true },
          });
          const trace = await tx.moderationAction.create({
            data: {
              adminUserId: ctx.adminUserId,
              actorLabel: ctx.actorLabel,
              action: "unhide",
              targetKind: "post",
              targetId,
              reason: typeof reason === "string" ? reason : null,
            },
          });
          await writeAdminAudit({
            tx,
            actorId: ctx.adminUserId,
            actorRole: ctx.role,
            action: "unhide",
            targetType: "post",
            targetId,
            after: { hiddenAt: row.hiddenAt },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            justification: typeof reason === "string" ? reason : null,
          });
          return { row, trace };
        });
        return NextResponse.json({
          action: updated.trace,
          affected: { post: { id: targetId, hiddenAt: updated.row.hiddenAt } },
        });
      }

      // purge — traces d'audit OBLIGATOIRES (post supprimé, traces conservées)
      try {
        const outcome = await db.$transaction((tx) =>
          purgePostWithAudit(tx, {
            postId: targetId,
            actor,
            reason: typeof reason === "string" ? reason : null,
          })
        );
        return NextResponse.json({
          action: {
            action: "purge",
            targetKind: "post",
            targetId,
            actorLabel: ctx.actorLabel,
          },
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
          ? { suspendedAt: handledAt, suspendedById: ctx.adminUserId }
          : action === "unsuspend"
            ? { suspendedAt: null, suspendedById: null }
            : {};
      const row = await tx.user.update({
        where: { id: user.id },
        data,
        select: { pubkey: true, suspendedAt: true },
      });
      if (openReports.length > 0) {
        await tx.report.updateMany({
          where: { id: { in: openReports.map((r) => r.id) } },
          data: { status: "actioned", handledAt, handledById: ctx.adminUserId },
        });
      }
      const trace = await tx.moderationAction.create({
        data: {
          adminUserId: ctx.adminUserId,
          actorLabel: ctx.actorLabel,
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
      await writeAdminAudit({
        tx,
        actorId: ctx.adminUserId,
        actorRole: ctx.role,
        action,
        targetType: "user",
        targetId,
        before: { suspendedAt: user.suspendedAt },
        after: { suspendedAt: row.suspendedAt, reportsClosed: openReports.length },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        justification: typeof reason === "string" ? reason : null,
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
