import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { withWriteLock } from "@/lib/mbote/write-mutex";
import { MODERATION_ACTIONS, purgePostWithAudit } from "@/lib/mbote/moderation";
import { isDenied, requireAdmin, roleAtLeast, writeAdminAudit, type AdminContext } from "@/lib/mbote/admin-auth";
import { parseJustification } from "@/lib/mbote/justification";
import {
  SUSPEND_DURATIONS_MS,
  applyUserSuspension,
  applyUserUnsuspension,
  applyUserWarning,
  findModerationTarget,
} from "@/lib/mbote/user-moderation";

export const dynamic = "force-dynamic";

/** Course de dismissal (stress S5 — Étape 10) : le report a été traité entre
 *  le pré-check hors tx et la transaction → perdant propre 409. */
class DismissRaceError extends Error {}

/**
 * Rôles MINIMAUX PAR ACTION — matrice RBAC §4 (ADMIN-RBAC.md) câblée à
 * l'Étape 4 : warn = support · hide/unhide/suspend/unsuspend/purge = moderator.
 * (support et auditor = lecture seule — directive Étape 4.)
 * ADM Étape 6 : report.dismiss = support (matrice §4 #6 — sort du périmètre
 * E6, arbitrage §12.12 de la spec : « dismiss n'existe PAS dans
 * MODERATION_ACTIONS (Étape 0) — reste au périmètre E6 (queue UI) »).
 */
const ACTION_MIN_ROLE: Record<string, string> = {
  warn: "support",
  dismiss: "support",
  hide: "moderator",
  unhide: "moderator",
  suspend: "moderator",
  unsuspend: "moderator",
  purge: "moderator",
};

/**
 * Durées de suspension — EXTRAITE Étape 7 : SUSPEND_DURATIONS_MS vit dans
 * src/lib/mbote/user-moderation.ts (partagée avec les endpoints internes E7 ;
 * "30d" ajouté à l'unification). imported en tête de fichier.
 */

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
 *  Rôles par action : matrice RBAC §4.
 *
 *  ADM Étape 6 — JUSTIFICATION §6 OBLIGATOIRE (ADMIN-RBAC.md, invariant §1.7) :
 *  chaque action exige {category ∈ SPAM|HARASSMENT|SCAM|CSAM|OTHER,
 *  justification ≥ 20 chars} — refus 422 sinon (validation SERVEUR). Format
 *  stocké : « CATÉGORIE: texte ». Les actions sont :
 *   - hide      (post)   : masqué — DISPARAÎT du fil public, RESTE en DB (audit)
 *   - unhide    (post)   : retour au fil public
 *   - purge     (post)   : SUPPRIMÉ en DB (cascade likes/réponses) — traces
 *                          ModerationAction + AdminAudit conservées
 *   - dismiss   (report) : signalement clos SANS action sur le contenu
 *                          (status=dismissed) — NOUVEAU Étape 6
 *   - warn      (user)   : avertissement enregistré + NOTIFICATION visible dans
 *                          le profil de l'utilisateur (UserWarning, migration
 *                          0006 — pas de DM, E2EE par conception)
 *   - suspend   (user)   : temporaire 24h/7d/30d (suspendedUntil — "30d"
 *                          ajouté Étape 7) ou indéfinie — posts absents du
 *                          fil public + publication refusée 403 tant que la
 *                          suspension tient (évaluation paresseuse, pas de
 *                          cron) ; transaction partagée user-moderation.ts
 *   - unsuspend (user)   : levée de suspension (suspendedAt/until/by cleared)
 *
 *  Chaque action écrit ModerationAction (label `admin-<id>`) ET AdminAudit
 *  (append-only) dans la même transaction — la justification y figure au
 *  format §6. L'acteur est `AdminUser.id` (traçable). Aucune réponse ne
 *  contient de secret.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("moderation.action");
  try {
    const gate = await requireAdmin(req, { minRole: "auditor", mutation: true });
    if (isDenied(gate)) return gate;
    const ctx: AdminContext = gate;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const { action, targetKind, targetId } = (body ?? {}) as Record<string, unknown>;

    // ADM Étape 6 — justification §6 obligatoire sur TOUTE mutation (422)
    const just = parseJustification(body ?? {});
    if (!just.ok) {
      return NextResponse.json({ error: just.error }, { status: 422 });
    }

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
    if (targetKind !== "post" && targetKind !== "user" && targetKind !== "report") {
      return NextResponse.json(
        { error: "targetKind invalide (\"post\" | \"user\" | \"report\") — aucune modération DM (E2EE par conception)" },
        { status: 400 }
      );
    }
    if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > 128) {
      return NextResponse.json({ error: "targetId invalide" }, { status: 400 });
    }

    const handledAt = new Date();
    const actor = {
      adminUserId: ctx.adminUserId,
      actorLabel: ctx.actorLabel,
      actorRole: ctx.role,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };

    // ── actions sur un signalement (dismiss — NOUVEAU Étape 6) ──────────────
    if (targetKind === "report") {
      if (action !== "dismiss") {
        return NextResponse.json(
          { error: `action "${action}" ne s'applique pas à un report (dismiss seul)` },
          { status: 400 }
        );
      }
      const report = await db.report.findUnique({ where: { id: targetId } });
      if (!report) {
        return NextResponse.json({ error: "Signalement introuvable" }, { status: 404 });
      }
      if (report.handledById !== null) {
        return NextResponse.json(
          { error: "Signalement déjà traité (status=" + report.status + ")" },
          { status: 409 }
        );
      }
      try {
        const result = await withWriteLock(() => db.$transaction(async (tx) => {
          // garde anti-course DANS la transaction (stress S5 — constat Étape 10) :
          // le pré-check ci-dessus est un read hors tx — deux dismiss
          // simultanés le passaient tous deux et le tx.report.update
          // inconditionnel écrivait DEUX lignes d'audit pour un seul report
          // (handledById = dernier écrivain). `where handledById: null` rend
          // le second dismiss un perdant PROPRE (409).
          const guarded = await tx.report.updateMany({
            where: { id: targetId, handledById: null },
            data: { status: "dismissed", handledAt, handledById: ctx.adminUserId },
          });
          if (guarded.count === 0) throw new DismissRaceError();
          const row = await tx.report.update({
            where: { id: targetId },
            data: { status: "dismissed", handledAt, handledById: ctx.adminUserId },
            select: { id: true, status: true, handledAt: true },
          });
          const trace = await tx.moderationAction.create({
            data: {
              adminUserId: ctx.adminUserId,
              actorLabel: ctx.actorLabel,
              action: "dismiss",
              targetKind: "report",
              targetId,
              reason: just.value.formatted,
            },
          });
          await writeAdminAudit({
            tx,
            actorId: ctx.adminUserId,
            actorRole: ctx.role,
            action: "dismiss",
            targetType: "report",
            targetId,
            before: { status: report.status },
            after: { status: row.status },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            justification: just.value.formatted,
          });
          return { row, trace };
        }));
        return NextResponse.json({
          action: result.trace,
          affected: { report: { id: result.row.id, status: result.row.status } },
        });
      } catch (err) {
        if (err instanceof DismissRaceError) {
          return NextResponse.json(
            { error: "Signalement déjà traité (course de dismissal)" },
            { status: 409 }
          );
        }
        throw err;
      }
    }

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
        const hiddenPost = await db.post.findUnique({
          where: { id: targetId },
          select: { authorId: true },
        });
        const updated = await withWriteLock(() => db.$transaction(async (tx) => {
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
          // D2 — Sybil phase 0 : un report CONFIRMÉ par un hide coûte −5 de
          // réputation et +1 flaggedCount à l'auteur du contenu (un hide
          // PROACTIF sans report n'est pas un report confirmé — pas de
          // pénalité). Dans la même transaction : réputation et trace
          // d'audit ne peuvent pas diverger.
          if (openReports.length > 0 && hiddenPost) {
            await tx.user.update({
              where: { id: hiddenPost.authorId },
              data: {
                reputationScore: { decrement: 5 },
                flaggedCount: { increment: 1 },
              },
            });
          }
          const trace = await tx.moderationAction.create({
            data: {
              adminUserId: ctx.adminUserId,
              actorLabel: ctx.actorLabel,
              action: "hide",
              targetKind: "post",
              targetId,
              reason: just.value.formatted,
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
            justification: just.value.formatted,
          });
          return { row, trace, closed: openReports.map((r) => r.id) };
        }));
        return NextResponse.json({
          action: updated.trace,
          affected: {
            post: { id: targetId, hiddenAt: updated.row.hiddenAt, hiddenById: updated.row.hiddenById },
            reportsClosed: updated.closed.length,
          },
        });
      }

      if (action === "unhide") {
        const updated = await withWriteLock(() => db.$transaction(async (tx) => {
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
              reason: just.value.formatted,
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
            justification: just.value.formatted,
          });
          return { row, trace };
        }));
        return NextResponse.json({
          action: updated.trace,
          affected: { post: { id: targetId, hiddenAt: updated.row.hiddenAt } },
        });
      }

      // purge — traces d'audit OBLIGATOIRES (post supprimé, traces conservées)
      try {
        const outcome = await withWriteLock(() => db.$transaction((tx) =>
          purgePostWithAudit(tx, {
            postId: targetId,
            actor,
            reason: just.value.formatted,
          })
        ));
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
    const user = await findModerationTarget(targetId);
    if (!user) {
      return NextResponse.json({ error: "Utilisateur introuvable" }, { status: 404 });
    }

    // suspension : durée obligatoire et valide (24h | 7d | 30d | indefinite) —
    // Étape 7 : "30d" ajouté au jeu Étape 6 (lib partagée user-moderation)
    if (action === "suspend") {
      const duration = (body?.duration as string) ?? "indefinite";
      if (!(duration in SUSPEND_DURATIONS_MS)) {
        return NextResponse.json(
          { error: "duration invalide (24h | 7d | 30d | indefinite)" },
          { status: 400 }
        );
      }
    }

    // Étape 7 — la transaction warn/suspend/unsuspend vit DANS la lib partagée
    // (src/lib/mbote/user-moderation.ts) : /api/moderation/action et les
    // endpoints internes E7 (/api/internal/admin/users/[id]/*) exécutent la
    // MÊME sémantique (UserWarning + reports clos + ModerationAction +
    // AdminAudit, une seule transaction). Réponse inchangée (tests Étape 6).
    const justArg = { user, ctx, just: just.value };
    const outcome =
      action === "warn"
        ? await applyUserWarning(justArg)
        : action === "suspend"
          ? await applyUserSuspension(justArg, (body?.duration as string) ?? "indefinite")
          : await applyUserUnsuspension(justArg);

    return NextResponse.json({
      action: outcome.trace,
      affected: {
        user: outcome.user,
        reportsClosed: outcome.reportsClosed,
        ...(action === "warn" ? { warningIssued: true } : {}),
      },
    });
  } catch (e) {
    console.error("POST /api/moderation/action", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
