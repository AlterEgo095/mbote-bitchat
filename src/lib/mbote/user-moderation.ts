/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  user-moderation — sémantique commune warn/suspend/unsuspend (ADM Étape 7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  EXTRACTION (Étape 7) : la branche « user » de POST /api/moderation/action
 *  (Étapes 0+6) et les NOUVEAUX endpoints /api/internal/admin/users/[id]/{warn,
 *  suspend,unsuspend} (Étape 7) partagent EXACTEMENT la même transaction :
 *
 *    User.update (suspension) ┐
 *    UserWarning.create (warn)│  même transaction Prisma — tout ou rien
 *    Report.closeMany (ouverts│  (un warn sans sa trace d'audit n'existe pas)
 *      sur les posts du user) │
 *    ModerationAction.create  │
 *    AdminAudit.create        ┘
 *
 *  INVARIANTS conservés à l'identique (aucune dérive sémantique — la suite
 *  128 tests d'Étape 6 + les nouveaux tests E7 le prouvent) :
 *   - warn → UserWarning (notification profil, §1.4 : pas de DM, E2EE) ;
 *   - suspend → suspension ACTIVE tant que suspendedAt != null ET
 *     (suspendedUntil == null OU suspendedUntil > now) — évaluation paresseuse
 *     aux points d'application (fil, publication), pas de cron ;
 *   - suspension/warn ferment les reports OUVERTS sur les posts de l'utilisateur
 *     (status=actioned, handledById posé) ;
 *   - justification §6 obligatoire (format « CATÉGORIE: texte », validée PAR
 *     L'APPELANT via parseJustification — cette couche exige déjà l'objet
 *     Justification, pas la string brute).
 *
 *  DURÉES (directive Étape 7 : dropdown 24h/7j/30j sur la fiche) : "30d" est
 *  AJOUTÉ au jeu Étape 6 (24h/7d/indefinite). "indefinite" = comportement A3
 *  historique (levée manuelle). L'endpoint E7 /suspend accepte 24h|7d|30d
 *  UNIQUEMENT (arbitrage §13.3) ; l'endpoint legacy /api/moderation/action
 *  conserve indefinite.
 *
 *  SESSIONS UTILISATEUR : « suspend + révocation » (directive Étape 7) — il
 *  n'existe AUCUNE session utilisateur aujourd'hui (identité = paire de clés
 *  locale, pas de login) : la révocation est un NO-OP documenté (§13.4).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { AdminContext, } from "@/lib/mbote/admin-auth";
import type { Justification } from "@/lib/mbote/justification";

/** Durées de suspension — Étape 6 (+ 30d Étape 7). "indefinite" → null. */
export const SUSPEND_DURATIONS_MS: Record<string, number | null> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
  indefinite: null,
};

/** Jeu ACCEPTÉ par l'endpoint E7 /api/internal/admin/users/[id]/suspend. */
export const E7_SUSPEND_DURATIONS = ["24h", "7d", "30d"] as const;
export type E7SuspendDuration = (typeof E7_SUSPEND_DURATIONS)[number];

/** Instantané minimal de la cible (chargé PAR L'APPELANT — 404 géré là-bas). */
export interface ModerationTargetUser {
  id: string;
  pubkey: string;
  nickname: string;
  suspendedAt: Date | null;
  suspendedUntil: Date | null;
}

export interface UserModerationOutcome {
  user: { pubkey: string; suspendedAt: Date | null; suspendedUntil: Date | null };
  /** reports ouverts sur les posts de l'utilisateur, CLOS par l'action */
  reportsClosed: number;
  trace: { action: string; targetKind: string; targetId: string };
}

interface ApplyArgs {
  user: ModerationTargetUser;
  ctx: AdminContext;
  just: Justification;
}

/** Durée ms d'une suspension « duration » (déjà validée par l'appelant). */
export function suspensionDeadline(handledAt: Date, duration: string): Date | null {
  const ms = SUSPEND_DURATIONS_MS[duration];
  return ms === null || ms === undefined ? null : new Date(handledAt.getTime() + ms);
}

/** Reports ouverts sur les posts de l'utilisateur (clôturés par warn/suspend). */
async function openReportIds(tx: Parameters<Parameters<typeof import("@/lib/db").db.$transaction>[0]>[0], userId: string): Promise<string[]> {
  const rows = (await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r.id FROM Report r
     JOIN Post p ON p.id = r.targetId
     WHERE p.authorId = ? AND r.status = 'open'`,
    userId
  )) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * WARN — avertissement visible dans le profil de l'utilisateur (UserWarning,
 * migration 0006). Aucun effet sur le compte (pas de suspension).
 */
export async function applyUserWarning({ user, ctx, just }: ApplyArgs): Promise<UserModerationOutcome> {
  const { db } = await import("@/lib/db");
  const handledAt = new Date();
  return db.$transaction(async (tx) => {
    const reportIds = await openReportIds(tx, user.id);
    if (reportIds.length > 0) {
      await tx.report.updateMany({
        where: { id: { in: reportIds } },
        data: { status: "actioned", handledAt, handledById: ctx.adminUserId },
      });
    }
    await tx.userWarning.create({
      data: {
        userId: user.id,
        category: just.category,
        note: just.text,
        createdById: ctx.adminUserId,
      },
    });
    const _trace = await tx.moderationAction.create({
      data: {
        adminUserId: ctx.adminUserId,
        actorLabel: ctx.actorLabel,
        action: "warn",
        targetKind: "user",
        targetId: user.pubkey,
        reason: just.formatted,
        reportIds: JSON.stringify(reportIds),
        meta: JSON.stringify({ nickname: user.nickname, closedReports: reportIds.length, warning: { category: just.category } }),
      },
    });
    const { writeAdminAudit } = await import("@/lib/mbote/admin-auth");
    await writeAdminAudit({
      tx,
      actorId: ctx.adminUserId,
      actorRole: ctx.role,
      action: "warn",
      targetType: "user",
      targetId: user.pubkey,
      before: { suspendedAt: user.suspendedAt, suspendedUntil: user.suspendedUntil },
      after: { suspendedAt: user.suspendedAt, suspendedUntil: user.suspendedUntil, reportsClosed: reportIds.length, warningIssued: just.category },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      justification: just.formatted,
    });
    return {
      user: { pubkey: user.pubkey, suspendedAt: user.suspendedAt, suspendedUntil: user.suspendedUntil },
      reportsClosed: reportIds.length,
      trace: { action: "warn", targetKind: "user", targetId: user.pubkey },
    };
  });
}

/**
 * SUSPEND — temporaire (24h/7d/30d/indefinite) : posts absents du fil public
 * + publication refusée 403 tant que la suspension tient ; DM POSSIBLE (E2EE
 * préservée — aucun contrôle de suspension dans /api/dms, testé E7).
 * Révocation de sessions : no-op (aucune session utilisateur, §13.4).
 */
export async function applyUserSuspension(
  { user, ctx, just }: ApplyArgs,
  duration: string
): Promise<UserModerationOutcome> {
  if (!(duration in SUSPEND_DURATIONS_MS)) {
    throw new Error(`duration invalide (${duration}) — l'appelant DOIT valider avant`);
  }
  const { db } = await import("@/lib/db");
  const handledAt = new Date();
  const suspendedUntil = suspensionDeadline(handledAt, duration);
  return db.$transaction(async (tx) => {
    const reportIds = await openReportIds(tx, user.id);
    if (reportIds.length > 0) {
      await tx.report.updateMany({
        where: { id: { in: reportIds } },
        data: { status: "actioned", handledAt, handledById: ctx.adminUserId },
      });
    }
    const row = await tx.user.update({
      where: { id: user.id },
      data: { suspendedAt: handledAt, suspendedById: ctx.adminUserId, suspendedUntil },
      select: { pubkey: true, suspendedAt: true, suspendedUntil: true },
    });
    const _trace = await tx.moderationAction.create({
      data: {
        adminUserId: ctx.adminUserId,
        actorLabel: ctx.actorLabel,
        action: "suspend",
        targetKind: "user",
        targetId: user.pubkey,
        reason: just.formatted,
        reportIds: JSON.stringify(reportIds),
        meta: JSON.stringify({ nickname: user.nickname, closedReports: reportIds.length, duration, suspendedUntil }),
      },
    });
    const { writeAdminAudit } = await import("@/lib/mbote/admin-auth");
    await writeAdminAudit({
      tx,
      actorId: ctx.adminUserId,
      actorRole: ctx.role,
      action: "suspend",
      targetType: "user",
      targetId: user.pubkey,
      before: { suspendedAt: user.suspendedAt, suspendedUntil: user.suspendedUntil },
      after: { suspendedAt: row.suspendedAt, suspendedUntil: row.suspendedUntil, reportsClosed: reportIds.length, duration },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      justification: just.formatted,
    });
    return {
      user: { pubkey: row.pubkey, suspendedAt: row.suspendedAt, suspendedUntil: row.suspendedUntil },
      reportsClosed: reportIds.length,
      trace: { action: "suspend", targetKind: "user", targetId: user.pubkey },
    };
  });
}

/**
 * UNSUSPEND — levée de suspension (suspendedAt/until/by cleared). Exposé
 * Étape 7 sur la fiche (arbitrage §13.5) : sans lui, une suspension 30d est
 * irréversible — intenable en exploitation.
 */
export async function applyUserUnsuspension({ user, ctx, just }: ApplyArgs): Promise<UserModerationOutcome> {
  const { db } = await import("@/lib/db");
  return db.$transaction(async (tx) => {
    const row = await tx.user.update({
      where: { id: user.id },
      data: { suspendedAt: null, suspendedById: null, suspendedUntil: null },
      select: { pubkey: true, suspendedAt: true, suspendedUntil: true },
    });
    const _trace = await tx.moderationAction.create({
      data: {
        adminUserId: ctx.adminUserId,
        actorLabel: ctx.actorLabel,
        action: "unsuspend",
        targetKind: "user",
        targetId: user.pubkey,
        reason: just.formatted,
        meta: JSON.stringify({ nickname: user.nickname }),
      },
    });
    const { writeAdminAudit } = await import("@/lib/mbote/admin-auth");
    await writeAdminAudit({
      tx,
      actorId: ctx.adminUserId,
      actorRole: ctx.role,
      action: "unsuspend",
      targetType: "user",
      targetId: user.pubkey,
      before: { suspendedAt: user.suspendedAt, suspendedUntil: user.suspendedUntil },
      after: { suspendedAt: row.suspendedAt, suspendedUntil: row.suspendedUntil },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      justification: just.formatted,
    });
    return {
      user: { pubkey: row.pubkey, suspendedAt: row.suspendedAt, suspendedUntil: row.suspendedUntil },
      reportsClosed: 0,
      trace: { action: "unsuspend", targetKind: "user", targetId: user.pubkey },
    };
  });
}

/** Charge une cible par PUBKEY (l'identifiant opératoire des traces admin). */
export async function findModerationTarget(pubkey: string): Promise<ModerationTargetUser | null> {
  const { db } = await import("@/lib/db");
  const u = await db.user.findUnique({
    where: { pubkey },
    select: { id: true, pubkey: true, nickname: true, suspendedAt: true, suspendedUntil: true },
  });
  return u;
}
