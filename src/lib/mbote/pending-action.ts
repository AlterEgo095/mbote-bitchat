/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  pending-action — FOUR-EYES ban définitif + purge (ADM Étape 9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 9 : « Ban définitif et purge ne peuvent PAS être faits par
 *  un seul admin. Une intention est créée par un super-admin, puis approuvée
 *  par un second admin distinct, dans un délai d'une heure. »
 *
 *  RÈGLE STRUCTURELLE (ADMIN-RBAC §4 règles + §5) : les actions irréversibles
 *  (9 ban.request, 10 post.purge.request) passent TOUJOURS par four-eyes, y
 *  compris un super-admin isolé. Les actions réversibles (warn, suspend,
 *  hide) restent mono-session (user-moderation.ts).
 *
 *  CYCLE (100 % audité — 2 lignes AdminAudit pour un cycle nominal) :
 *    request  → status=pending + audit `pendingaction_created`
 *    approve  → EXÉCUTION TRANSACTIONNELLE de la vraie action
 *               (applyUserBan | purgePostWithAudit — ligne `ban` | `purge`)
 *               + status=executed, approvedById/at, executedAt
 *    cancel   → (demandeur UNIQUEMENT) status=cancelled + audit `_cancelled`
 *    expire   → évaluée PARESSEUSEMENT (approbation → 410 ; GET liste marque
 *               `expired` + audit `_expired` — pas de cron, pattern É6)
 *
 *  GARDES (toutes serveur, testées E9) :
 *    - auto-approbation impossible : approbateur ≠ demandeur PAR ID **ET** PAR
 *      SESSION (double garde — 2 sessions du même admin sont refusées aussi) ;
 *    - expiresAt = createdAt + 1 h, refus 410 Gone au-delà ;
 *    - refus si action disponible à un seul modérateur (warn/suspend) —
 *      actionType fermé : `ban_user` | `purge_post` UNIQUEMENT ;
 *    - refus 409 si une PENDING existe déjà pour (actionType, targetId) ;
 *    - RBAC : create/approve/cancel = super-admin (tranché 2026-11-06 —
 *      directive É9, matrice §4 #9-11 réalignée) ; liste = moderator min
 *      (support/auditor → 403) ;
 *    - exécution = UNE transaction : effet + ModerationAction + AdminAudit +
 *      PendingAction.executed — un ban sans sa trace d'audit n'existe pas.
 *
 *  NOTIFICATION (directive : « notification email (log en attendant SMTP) ») :
 *  à chaque demande, log structuré vers les autres super-admins actifs
 *  (emails) — `[pending-action:notify]`. SMTP absent → NON TESTÉ (documenté).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { AdminContext } from "@/lib/mbote/admin-auth";
import type { Justification } from "@/lib/mbote/justification";
import type { PurgeActor } from "@/lib/mbote/moderation";
import { withWriteLock } from "@/lib/mbote/write-mutex";

export const PENDING_ACTION_TYPES = ["ban_user", "purge_post"] as const;
export type PendingActionType = (typeof PENDING_ACTION_TYPES)[number];

export const PENDING_ACTION_STATUSES = [
  "pending",
  "executed",
  "cancelled",
  "expired",
] as const;
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

/** Directive : « expiresAt = requestedAt + 1h ». */
export const PENDING_ACTION_TTL_MS = 3600_000;

export const FOUR_EYES_ACTION_LABEL: Record<PendingActionType, string> = {
  ban_user: "ban",
  purge_post: "purge",
};

type Tx = Parameters<Parameters<typeof import("@/lib/db").db.$transaction>[0]>[0];

async function txClient(): Promise<typeof import("@/lib/db").db> {
  const { db } = await import("@/lib/db");
  return db;
}

function auditCtx(ctx: AdminContext) {
  return { ip: ctx.ip, userAgent: ctx.userAgent };
}

/** Forme ligne + include (demandeur/approbateur) utilisée par les handlers. */
export interface PendingActionRow {
  id: number;
  actionType: string;
  targetType: string;
  targetId: string;
  payloadJson: string | null;
  justification: string;
  status: string;
  createdById: number;
  createdBySessionId: string;
  approvedById: number | null;
  approvedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  createdBy: { email: string };
  approvedBy: { email: string } | null;
}

/** Charge + qualifie une PendingAction : 404 absente, 410 expirée, 409 statut. */
export async function loadPendingAction(id: number): Promise<
  | { ok: true; action: PendingActionRow }
  | { ok: false; status: 404 | 409 | 410; error: string }
> {
  const db = await txClient();
  const action = await db.pendingAction.findUnique({
    where: { id },
    include: {
      createdBy: { select: { email: true } },
      approvedBy: { select: { email: true } },
    },
  });
  if (!action) return { ok: false, status: 404, error: "Intention introuvable" };
  const row: PendingActionRow = {
    id: action.id,
    actionType: action.actionType,
    targetType: action.targetType,
    targetId: action.targetId,
    payloadJson: action.payloadJson,
    justification: action.justification,
    status: action.status,
    createdById: action.createdById,
    createdBySessionId: action.createdBySessionId,
    approvedById: action.approvedById,
    approvedAt: action.approvedAt,
    executedAt: action.executedAt,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    createdBy: { email: action.createdBy.email },
    approvedBy: action.approvedBy ? { email: action.approvedBy.email } : null,
  };
  if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    // expiration paresseuse avec trace — identique au pattern É6 suspend
    await expireIfDue(row.id);
    return { ok: false, status: 410, error: "Intention expirée (1 h) — posons-en une nouvelle" };
  }
  if (row.status === "expired") {
    // une intention DÉJÀ marquée expirée reste un 410 Gone (directive É9 :
    // « intention expirée → 410 Gone » — y compris pour annuler)
    return { ok: false, status: 410, error: "Intention expirée (1 h) — posons-en une nouvelle" };
  }
  if (row.status !== "pending") {
    return {
      ok: false,
      status: 409,
      error: `Intention déjà traitée (statut : ${row.status})`,
    };
  }
  return { ok: true, action: row };
}

/** Marque `expired` les pendings échues (balayage passif, audité par ligne). */
export async function expireIfDue(id: number): Promise<boolean> {
  const db = await txClient();
  const now = new Date();
  const row = await db.pendingAction.findUnique({ where: { id } });
  if (!row || row.status !== "pending" || row.expiresAt.getTime() > now.getTime()) {
    return false;
  }
  return withWriteLock(() =>
    db.$transaction(
    async (tx) => {
    const updated = await tx.pendingAction.updateMany({
      where: { id, status: "pending" }, // course : un seul gagne
      data: { status: "expired" },
    });
    if (updated.count === 0) return false;
    await tx.adminAudit.create({
      data: {
        actorId: row.createdById,
        actorRole: "system", // expiration = mécanique, pas un acteur humain
        action: "pendingaction_expired",
        targetType: row.targetType,
        targetId: row.targetId,
        afterJson: JSON.stringify({
          pendingActionId: row.id,
          actionType: row.actionType,
          requestedBy: `admin-${row.createdById}`,
          expiredAt: now.toISOString(),
        }),
        justification: row.justification,
      },
    });
    return true;
  }));
}

/** Balayage du GET liste : toutes les pendings échues deviennent `expired`. */
export async function expireAllDue(): Promise<number> {
  const db = await txClient();
  const due = await db.pendingAction.findMany({
    where: { status: "pending", expiresAt: { lte: new Date() } },
    select: { id: true },
  });
  let n = 0;
  for (const { id } of due) {
    if (await expireIfDue(id)) n += 1;
  }
  return n;
}

// ───────────────────────── REQUEST ─────────────────────────

export interface RequestPendingActionArgs {
  ctx: AdminContext; // session vérifiée super-admin (garde endpoint)
  actionType: PendingActionType;
  targetId: string;
  just: Justification;
}

export type RequestPendingActionResult =
  | { ok: true; pendingAction: { id: number; expiresAt: Date; status: string } }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Crée l'intention (sans exécuter quoi que ce soit). Vérifie que la cible
 * existe et est banable/purgeable, refuse le doublon pending, fige un
 * contexte lisible (payloadJson), audit `pendingaction_created` puis
 * notifie (log) les autres super-admins.
 */
export async function requestPendingAction({
  ctx,
  actionType,
  targetId,
  just,
}: RequestPendingActionArgs): Promise<RequestPendingActionResult> {
  const db = await txClient();

  // cible : chargée AVANT la création (404 sans ligne créée)
  let payload: Record<string, unknown>;
  if (actionType === "ban_user") {
    const user = await db.user.findUnique({
      where: { pubkey: targetId },
      select: { id: true, pubkey: true, nickname: true, bannedAt: true, suspendedAt: true, suspendedUntil: true },
    });
    if (!user) return { ok: false, status: 404, error: "Utilisateur introuvable" };
    if (user.bannedAt) {
      return { ok: false, status: 409, error: "Utilisateur déjà banni définitivement" };
    }
    payload = { pubkey: user.pubkey, nickname: user.nickname };
  } else {
    const post = await db.post.findUnique({
      where: { id: targetId },
      select: { id: true, content: true, author: { select: { pubkey: true, nickname: true } } },
    });
    if (!post) return { ok: false, status: 404, error: "Post introuvable (déjà purgé ?)" };
    payload = {
      postId: post.id,
      authorKey: post.author.pubkey,
      nickname: post.author.nickname,
      snippet: post.content.trim().slice(0, 280),
    };
  }

  // doublon : une seule intention OUVERTE par (actionType, cible)
  const existing = await db.pendingAction.findFirst({
    where: { actionType, targetId, status: "pending" },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: `Une intention ${actionType} est déjà en attente pour cette cible (#${existing.id})`,
    };
  }

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + PENDING_ACTION_TTL_MS);
  let row: Awaited<ReturnType<typeof db.pendingAction.create>>;
  try {
    row = await db.pendingAction.create({
      data: {
        actionType,
        targetType: actionType === "ban_user" ? "user" : "post",
        targetId,
        payloadJson: JSON.stringify(payload),
        justification: just.formatted,
        status: "pending",
        createdById: ctx.adminUserId,
        createdBySessionId: ctx.sessionId,
        createdAt,
        expiresAt,
      },
    });
  } catch (e) {
    // course de création (stress S4 — constat Étape 10) : deux super-admins
    // passent TOUS DEUX le findFirst ci-dessus (TOCTOU), l'index unique partiel
    // `pending_action_unique_open` (migration 0008) refuse le 2ᵉ create →
    // 409 propre avec l'intention gagnante, jamais deux pendings.
    const isUniqueRace =
      (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") ||
      (e instanceof Error && /pending_action_unique_open|UNIQUE constraint failed/.test(e.message));
    if (isUniqueRace) {
      const winner = await db.pendingAction.findFirst({
        where: { actionType, targetId, status: "pending" },
        select: { id: true },
      });
      return {
        ok: false,
        status: 409,
        error: `Une intention ${actionType} est déjà en attente pour cette cible (#${winner?.id ?? "?"})`,
      };
    }
    throw e;
  }

  // ligne 1 du cycle : request (audité dans la même portée logique —
  // la pending elle-même est réversible, l'audit reste hors tx d'effet)
  const { writeAdminAudit } = await import("@/lib/mbote/admin-auth");
  await writeAdminAudit({
    ...auditCtx(ctx),
    actorId: ctx.adminUserId,
    actorRole: ctx.role,
    action: "pendingaction_created",
    targetType: actionType === "ban_user" ? "user" : "post",
    targetId,
    after: {
      pendingActionId: row.id,
      actionType,
      requestedBy: ctx.actorLabel,
      requestedByEmail: ctx.email,
      expiresAt: expiresAt.toISOString(),
    },
    justification: just.formatted,
  });

  // notification « email » — log structuré en attendant SMTP (NON TESTÉ, §proofs)
  const otherSuperAdmins = await db.adminUser.findMany({
    where: { role: "super-admin", disabledAt: null, id: { not: ctx.adminUserId } },
    select: { id: true, email: true },
  });
  console.warn(
    `[pending-action:notify] nouvelle intention #${row.id} ${actionType} cible=${targetId} ` +
      `par ${ctx.email} — à approuver par un second super-admin avant ${expiresAt.toISOString()}` +
      (otherSuperAdmins.length > 0
        ? ` — destinataires: ${otherSuperAdmins.map((a) => a.email).join(", ")}`
        : " — destinataires: (aucun autre super-admin actif)")
  );

  return {
    ok: true,
    pendingAction: { id: row.id, expiresAt: row.expiresAt, status: row.status },
  };
}

// ───────────────────────── APPROVE (→ EXECUTE) ─────────────────────────

export interface ApprovePendingActionArgs {
  ctx: AdminContext; // session vérifiée super-admin (garde endpoint)
  actionId: number;
}

export type ApprovePendingActionResult =
  | {
      ok: true;
      executed: {
        pendingActionId: number;
        actionType: PendingActionType;
        requestedBy: { id: number; email: string };
        approvedBy: { id: number; email: string };
        outcome: Record<string, unknown>;
      };
    }
  | { ok: false; status: 403 | 404 | 409 | 410; error: string };

/**
 * Approbation PAR UN SECOND ADMIN DISTINCT → exécution immédiate de la vraie
 * action DANS UNE TRANSACTION. Refus 403 si approbateur = demandeur (id ou
 * session). Refus 410 si l'intention a expiré. La ligne d'audit d'exécution
 * est celle de la VRAIE action (ban | purge) — cycle = 2 lignes exactement.
 */
export async function approvePendingAction({
  ctx,
  actionId,
}: ApprovePendingActionArgs): Promise<ApprovePendingActionResult> {
  const loaded = await loadPendingAction(actionId);
  if (!loaded.ok) return loaded;
  const action = loaded.action as unknown as {
    id: number;
    actionType: PendingActionType;
    targetType: string;
    targetId: string;
    payloadJson: string | null;
    justification: string;
    createdById: number;
    createdBySessionId: string;
    createdBy: { email: string };
  };

  // GARDE four-eyes : approbateur ≠ demandeur PAR ID **ET** PAR SESSION
  if (action.createdById === ctx.adminUserId) {
    return {
      ok: false,
      status: 403,
      error: "Auto-approbation impossible — le demandeur ne peut pas approuver sa propre intention",
    };
  }
  if (action.createdBySessionId === ctx.sessionId) {
    return {
      ok: false,
      status: 403,
      error: "Auto-approbation impossible — même session que le demandeur (reconnectez-vous sous un compte distinct)",
    };
  }

  const db = await txClient();
  const { purgePostWithAudit } = await import("@/lib/mbote/moderation");

  const executed = await withWriteLock(() => db.$transaction(async (tx) => {
    // re-prise TX (course : deux approuveurs simultanés — un seul gagne)
    const fresh = await tx.pendingAction.findUnique({ where: { id: action.id } });
    if (!fresh || fresh.status !== "pending") {
      throw new PendingActionRaceError();
    }

    let outcome: Record<string, unknown>;
    if (action.actionType === "ban_user") {
      outcome = await applyUserBanInTx(tx, {
        pubkey: action.targetId,
        executor: ctx,
        request: action,
      });
    } else {
      const purgeActor: PurgeActor = {
        adminUserId: ctx.adminUserId,
        actorLabel: ctx.actorLabel,
        actorRole: ctx.role,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      };
      const purge = await purgePostWithAudit(tx, {
        postId: action.targetId,
        actor: purgeActor,
        reason: action.justification,
        fourEyes: {
          pendingActionId: action.id,
          requestedById: action.createdById,
          requestedByEmail: action.createdBy.email,
          approvedById: ctx.adminUserId,
        },
      });
      outcome = purge as unknown as Record<string, unknown>;
    }

    await tx.pendingAction.update({
      where: { id: action.id },
      data: {
        status: "executed",
        approvedById: ctx.adminUserId,
        approvedAt: new Date(),
        executedAt: new Date(),
      },
    });

    // exécution ban : la ligne d'audit `ban` est écrite par applyUserBanInTx ;
    // exécution purge : la ligne `purge` est écrite par purgePostWithAudit —
    // les deux incluent requestedBy/approvedBy. Cycle = 2 lignes exactement.
    return outcome;
  }).catch((e) => {
    if (e instanceof PendingActionRaceError) return null;
    throw e;
  }));

  if (executed === null) {
    return { ok: false, status: 409, error: "Intention déjà traitée (course d'approbation)" };
  }

  return {
    ok: true,
    executed: {
      pendingActionId: action.id,
      actionType: action.actionType,
      requestedBy: { id: action.createdById, email: action.createdBy.email },
      approvedBy: { id: ctx.adminUserId, email: ctx.email },
      outcome: executed,
    },
  };
}

class PendingActionRaceError extends Error {
  constructor() {
    super("pending action déjà traitée");
    this.name = "PendingActionRaceError";
  }
}

/**
 * BAN définitif DANS LA TRANSACTION FOUR-EYES — pattern user-moderation.ts :
 *   (1) reports ouverts sur les posts de l'utilisateur clos ;
 *   (2) User.bannedAt + bannedBy (pas de unban UI, §5) ;
 *   (3) posts visibles masqués (hiddenById = admin EXÉCUTANT — directive :
 *       « ses posts/commentaires masqués, hiddenBy = admin qui a exécuté ») ;
 *   (4) ModerationAction (action "ban") ;
 *   (5) AdminAudit (action "ban", before/after incluant requestedBy/approvedBy).
 */
async function applyUserBanInTx(
  tx: Tx,
  args: {
    pubkey: string;
    executor: AdminContext;
    request: {
      id: number;
      justification: string;
      createdById: number;
      createdBy: { email: string };
    };
  }
): Promise<Record<string, unknown>> {
  const { pubkey, executor, request } = args;
  const user = await tx.user.findUnique({
    where: { pubkey },
    select: {
      id: true,
      pubkey: true,
      nickname: true,
      suspendedAt: true,
      suspendedUntil: true,
      bannedAt: true,
    },
  });
  if (!user) throw new Error("BAN_TARGET_NOT_FOUND");
  if (user.bannedAt) throw new Error("BAN_ALREADY_BANNED");

  const now = new Date();

  // (1) reports ouverts sur les posts de l'utilisateur
  const reportRows = (await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT r.id FROM Report r
     JOIN Post p ON p.id = r.targetId
     WHERE p.authorId = ? AND r.status = 'open'`,
    user.id
  )) as Array<{ id: string }>;
  if (reportRows.length > 0) {
    await tx.report.updateMany({
      where: { id: { in: reportRows.map((r) => r.id) } },
      data: { status: "actioned", handledAt: now, handledById: executor.adminUserId },
    });
  }

  // (2) ban définitif
  const row = await tx.user.update({
    where: { id: user.id },
    data: { bannedAt: now, bannedById: executor.adminUserId },
    select: { pubkey: true, bannedAt: true },
  });

  // (3) masquage des posts visibles (hiddenById = exécutant)
  const hidden = await tx.post.updateMany({
    where: { authorId: user.id, hiddenAt: null },
    data: { hiddenAt: now, hiddenById: executor.adminUserId },
  });

  // (4) ModerationAction
  await tx.moderationAction.create({
    data: {
      adminUserId: executor.adminUserId,
      actorLabel: executor.actorLabel,
      action: "ban",
      targetKind: "user",
      targetId: pubkey,
      reason: request.justification,
      reportIds: JSON.stringify(reportRows.map((r) => r.id)),
      meta: JSON.stringify({
        nickname: user.nickname,
        closedReports: reportRows.length,
        postsHidden: hidden.count,
        fourEyes: {
          pendingActionId: request.id,
          requestedBy: `admin-${request.createdById}`,
          requestedByEmail: request.createdBy.email,
          approvedBy: executor.actorLabel,
        },
      }),
    },
  });

  // (5) AdminAudit — ligne d'EXÉCUTION du cycle (ligne 2/2)
  await tx.adminAudit.create({
    data: {
      actorId: executor.adminUserId,
      actorRole: executor.role,
      action: "ban",
      targetType: "user",
      targetId: pubkey,
      beforeJson: JSON.stringify({
        bannedAt: user.bannedAt,
        suspendedAt: user.suspendedAt,
        suspendedUntil: user.suspendedUntil,
        visiblePosts: null,
      }),
      afterJson: JSON.stringify({
        bannedAt: row.bannedAt,
        bannedBy: executor.actorLabel,
        postsHidden: hidden.count,
        reportsClosed: reportRows.length,
        fourEyes: {
          pendingActionId: request.id,
          requestedBy: `admin-${request.createdById}`,
          requestedByEmail: request.createdBy.email,
          approvedBy: executor.actorLabel,
        },
      }),
      ip: executor.ip,
      userAgent: executor.userAgent,
      justification: request.justification,
    },
  });

  return {
    pubkey,
    bannedAt: row.bannedAt,
    postsHidden: hidden.count,
    reportsClosed: reportRows.length,
  };
}

// ───────────────────────── CANCEL ─────────────────────────

export interface CancelPendingActionArgs {
  ctx: AdminContext;
  actionId: number;
}

export type CancelPendingActionResult =
  | { ok: true; pendingAction: { id: number; status: string } }
  | { ok: false; status: 403 | 404 | 409 | 410; error: string };

/**
 * Annulation PAR LE DEMANDEUR UNIQUEMENT (directive É9 : bouton « Annuler »
 * si currentUser === requestedBy). Aucune mutation de cible — l'audit trace
 * `_cancelled`. Une intention expirée passe en 410 (jamais « cancelled »).
 */
export async function cancelPendingAction({
  ctx,
  actionId,
}: CancelPendingActionArgs): Promise<CancelPendingActionResult> {
  const loaded = await loadPendingAction(actionId);
  if (!loaded.ok) return loaded;
  const action = loaded.action as unknown as {
    id: number;
    targetType: string;
    targetId: string;
    justification: string;
    createdById: number;
    createdBySessionId: string;
  };

  if (action.createdById !== ctx.adminUserId) {
    return { ok: false, status: 403, error: "Seul le demandeur peut annuler son intention" };
  }
  if (action.createdBySessionId !== ctx.sessionId) {
    return { ok: false, status: 403, error: "Annulation impossible depuis une session différente du demandeur" };
  }

  const db = await txClient();
  const { writeAdminAudit } = await import("@/lib/mbote/admin-auth");
  const outcome = await withWriteLock(() => db.$transaction(async (tx) => {
    const updated = await tx.pendingAction.updateMany({
      where: { id: action.id, status: "pending" },
      data: { status: "cancelled" },
    });
    if (updated.count === 0) throw new PendingActionRaceError();
    // ⚠️ tx OBLIGATOIRE : sans lui, writeAdminAudit écrit via le client global
    // DANS une transaction ouverte → file lock SQLite → deadlock (bug attrapé
    // par ce harnais au 2ᵉ run — le pool était bloqué 5 s par cancel).
    await writeAdminAudit({
      tx,
      ...auditCtx(ctx),
      actorId: ctx.adminUserId,
      actorRole: ctx.role,
      action: "pendingaction_cancelled",
      targetType: action.targetType,
      targetId: action.targetId,
      after: { pendingActionId: action.id, requestedBy: ctx.actorLabel },
      justification: action.justification,
    });
  }).catch((e) => {
    if (e instanceof PendingActionRaceError) return null;
    throw e;
  }));
  if (outcome === null) {
    return { ok: false as const, status: 409 as const, error: "Intention déjà traitée (course d'annulation)" };
  }

  return { ok: true as const, pendingAction: { id: action.id, status: "cancelled" } };
}

// ───────────────────────── LIST ─────────────────────────

export interface PendingActionListItem {
  id: number;
  actionType: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown> | null;
  justification: string;
  status: string;
  requestedBy: { id: number; email: string };
  approvedBy: { id: number; email: string } | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  /** pour l'UI : approvable si le viewer n'est ni le demandeur ni sa session */
  canApprove: boolean;
  canCancel: boolean;
  expiredNow: boolean;
}

/** Liste (page /pending-actions). `viewerSessionId` permet les drapeaux UI. */
export async function listPendingActions(args: {
  ctx: AdminContext;
  viewerSessionId: string;
  status?: string;
  limit?: number;
}): Promise<PendingActionListItem[]> {
  const db = await txClient();
  const status =
    args.status && (PENDING_ACTION_STATUSES as readonly string[]).includes(args.status)
      ? args.status
      : undefined;
  const rows = await db.pendingAction.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(args.limit ?? 100, 1), 200),
    include: {
      createdBy: { select: { email: true } },
      approvedBy: { select: { email: true } },
    },
  });
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    actionType: r.actionType,
    targetType: r.targetType,
    targetId: r.targetId,
    payload: r.payloadJson ? (JSON.parse(r.payloadJson) as Record<string, unknown>) : null,
    justification: r.justification,
    status: r.status,
    requestedBy: { id: r.createdById, email: r.createdBy.email },
    approvedBy: r.approvedById && r.approvedBy ? { id: r.approvedById, email: r.approvedBy.email } : null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    approvedAt: r.approvedAt?.toISOString() ?? null,
    executedAt: r.executedAt?.toISOString() ?? null,
    canApprove: r.status === "pending" && r.createdById !== args.ctx.adminUserId && r.createdBySessionId !== args.viewerSessionId,
    canCancel: r.status === "pending" && r.createdById === args.ctx.adminUserId && r.createdBySessionId === args.viewerSessionId,
    expiredNow: r.status === "pending" && r.expiresAt.getTime() <= now,
  }));
}
