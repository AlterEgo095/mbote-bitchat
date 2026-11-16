/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  e2ee-purge — purges de CONTENUS CHIFFRÉS (DM / groupes MLS), auditées
 * ─────────────────────────────────────────────────────────────────────────────
 *  Back-office 2026-11 (directive « l'admin peut gérer tout ce que le serveur
 *  détient ») : les DM et messages de groupe sont E2EE (invariant §1.4) — le
 *  serveur n'en voit QUE du ciphertext opaque. Ces purges détruisent donc le
 *  ciphertext (irréversible) sans JAMAIS en révéler le contenu : les journaux
 *  d'audit ne contiennent que des MÉTADONNÉES (compteurs, tailles, clés
 *  publiques — données déjà visibles du serveur).
 *
 *  Deux sémantiques, un seul shape d'audit (miroir de purgePostWithAudit) :
 *    - purgeDmPairWithAudit       → cible `dm_pair` (paire canonique triée)
 *    - purgeGroupMessagesWithAudit → cible `group` (shell + membres CONSERVÉS,
 *      seuls les contenus chiffrés — GroupMessage + GroupEnvelope — sont
 *      détruits ; l'exclusion d'un membre reste le mécanisme leftAt dédié)
 *
 *  CYCLE FOUR-EYES (É9) : ces fonctions ne sont appelées QUE depuis
 *  approvePendingAction (PendingAction approuvée par un second super-admin) —
 *  le bloc fourEyes est injecté dans meta + afterJson de la MÊME ligne d'audit
 *  (cycle = 2 lignes AdminAudit exactement : pendingaction_created + purge).
 *
 *  Rien ici n'est exposé à un endpoint mono-admin : toute création passe par
 *  POST /api/internal/admin/pending-actions (super-admin, justification §6).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Prisma } from "@prisma/client";

import type { PurgeActor } from "@/lib/mbote/moderation";

export interface FourEyesBlock {
  pendingActionId: number;
  requestedById: number;
  requestedByEmail: string;
  approvedById: number;
}

export interface DmPairPurgeOutcome {
  pair: string;
  keyA: string;
  keyB: string;
  deletedMessages: number;
  unreadPurged: number;
  bytesFreed: number;
}

export interface GroupMessagesPurgeOutcome {
  groupId: string;
  name: string;
  deletedMessages: number;
  deletedEnvelopes: number;
}

/** Scinde la paire canonique `keyA|keyB` (triée) — 400-shape : false si invalide. */
export function parseDmPair(pair: string): { keyA: string; keyB: string } | null {
  if (pair.length === 0 || pair.length > 401) return null; // 2 × 200 + séparateur
  const parts = pair.split("|");
  if (parts.length !== 2) return null;
  const [keyA, keyB] = parts;
  if (keyA.length === 0 || keyB.length === 0) return null;
  if (keyA.length > 200 || keyB.length > 200) return null;
  // canonique : keyA <= keyB (tri asc) — le demandeur fige la forme triée
  if (keyA > keyB) return null;
  return { keyA, keyB };
}

/** Clé canonique d'une paire (tri asc, jointure « | ») — utilisée par les endpoints DM. */
export function dmPairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Purge IRREVERSIBLE de tous les DM d'une paire (les deux sens) DANS LA
 * TRANSACTION FOUR-EYES. Audit métadonnées uniquement : compteurs + tailles
 * (LENGTH du ciphertext) — jamais d'iv/ciphertext (rien de lisible n'existe).
 */
export async function purgeDmPairWithAudit(
  tx: Prisma.TransactionClient,
  params: {
    pair: string;
    actor: PurgeActor;
    reason?: string | null;
    fourEyes?: FourEyesBlock;
  }
): Promise<DmPairPurgeOutcome> {
  const parsed = parseDmPair(params.pair);
  if (!parsed) throw new Error("DM_PAIR_MALFORMED");
  const { keyA, keyB } = parsed;

  const where: Prisma.DirectMessageWhereInput = {
    OR: [
      { senderKey: keyA, recipientKey: keyB },
      { senderKey: keyB, recipientKey: keyA },
    ],
  };

  // état AVANT purge (métadonnées — compteur, non-lus, octets de ciphertext)
  // NB : LENGTH(ciphertext) évalué en SQL brut (pas d'agrégat Prisma natif)
  const rawBefore = (await tx.$queryRawUnsafe<Array<{ n: number; b: number; u: number }>>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN readAt IS NULL THEN 1 ELSE 0 END), 0) AS u,
            COALESCE(SUM(LENGTH(ciphertext)), 0) AS b
     FROM DirectMessage
     WHERE (senderKey = ? AND recipientKey = ?) OR (senderKey = ? AND recipientKey = ?)`,
    keyA, keyB, keyB, keyA
  )) as Array<{ n: number; b: number; u: number }>;
  const before = rawBefore[0] ?? { n: 0, b: 0, u: 0 };
  if (Number(before.n) === 0) throw new Error("DM_PAIR_EMPTY");

  const deleted = await tx.directMessage.deleteMany({ where });

  const meta = {
    pair: params.pair,
    keyA,
    keyB,
    deletedMessages: deleted.count,
    unreadPurged: Number(before.u),
    bytesFreed: Number(before.b),
    ...(params.fourEyes
      ? {
          fourEyes: {
            pendingActionId: params.fourEyes.pendingActionId,
            requestedBy: `admin-${params.fourEyes.requestedById}`,
            requestedByEmail: params.fourEyes.requestedByEmail,
            approvedBy: `admin-${params.fourEyes.approvedById}`,
          },
        }
      : {}),
  };

  await tx.moderationAction.create({
    data: {
      adminUserId: params.actor.adminUserId,
      actorLabel: params.actor.actorLabel,
      action: "purge",
      targetKind: "dm_pair",
      targetId: params.pair,
      reason: params.reason ?? null,
      reportIds: "[]", // les DM ne sont pas signalables (refus endpoint §reports)
      meta: JSON.stringify(meta),
    },
  });

  await tx.adminAudit.create({
    data: {
      actorId: params.actor.adminUserId,
      actorRole: params.actor.actorRole,
      action: "purge",
      targetType: "dm_pair",
      targetId: params.pair,
      beforeJson: JSON.stringify({
        messageCount: Number(before.n),
        unreadCount: Number(before.u),
        bytes: Number(before.b),
      }),
      afterJson: JSON.stringify(meta),
      ip: params.actor.ip ?? null,
      userAgent: params.actor.userAgent ?? null,
      justification: params.reason ?? null,
    },
  });

  return {
    pair: params.pair,
    keyA,
    keyB,
    deletedMessages: deleted.count,
    unreadPurged: Number(before.u),
    bytesFreed: Number(before.b),
  };
}

/**
 * Purge IRREVERSIBLE des CONTENUS CHIFFRÉS d'un groupe (GroupMessage +
 * GroupEnvelope — ciphertext MLS opaques) DANS LA TRANSACTION FOUR-EYES.
 * Le shell du groupe (Group, GroupMember) est CONSERVÉ : l'exclusion d'un
 * membre reste le mécanisme leftAt dédié (forward secrecy), la purge ne
 * porte que sur les données chiffrées détenues par le serveur.
 */
export async function purgeGroupMessagesWithAudit(
  tx: Prisma.TransactionClient,
  params: {
    groupId: string;
    actor: PurgeActor;
    reason?: string | null;
    fourEyes?: FourEyesBlock;
  }
): Promise<GroupMessagesPurgeOutcome> {
  const group = await tx.group.findUnique({
    where: { id: params.groupId },
    select: { id: true, name: true, mlsGroupId: true },
  });
  if (!group) throw new Error("GROUP_NOT_FOUND");

  const [messageCount, envelopeCount, activeMembers, lastMessage] = await Promise.all([
    tx.groupMessage.count({ where: { groupId: group.id } }),
    tx.groupEnvelope.count({ where: { groupId: group.id } }),
    tx.groupMember.count({ where: { groupId: group.id, leftAt: null } }),
    tx.groupMessage.findFirst({
      where: { groupId: group.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  if (messageCount === 0 && envelopeCount === 0) throw new Error("GROUP_EMPTY");

  const deletedMessages = await tx.groupMessage.deleteMany({ where: { groupId: group.id } });
  const deletedEnvelopes = await tx.groupEnvelope.deleteMany({ where: { groupId: group.id } });

  const meta = {
    groupId: group.id,
    name: group.name,
    mlsGroupId: group.mlsGroupId,
    deletedMessages: deletedMessages.count,
    deletedEnvelopes: deletedEnvelopes.count,
    activeMembers,
    ...(params.fourEyes
      ? {
          fourEyes: {
            pendingActionId: params.fourEyes.pendingActionId,
            requestedBy: `admin-${params.fourEyes.requestedById}`,
            requestedByEmail: params.fourEyes.requestedByEmail,
            approvedBy: `admin-${params.fourEyes.approvedById}`,
          },
        }
      : {}),
  };

  await tx.moderationAction.create({
    data: {
      adminUserId: params.actor.adminUserId,
      actorLabel: params.actor.actorLabel,
      action: "purge",
      targetKind: "group",
      targetId: group.id,
      reason: params.reason ?? null,
      reportIds: "[]", // les messages MLS ne sont pas signalables (E2EE)
      meta: JSON.stringify(meta),
    },
  });

  await tx.adminAudit.create({
    data: {
      actorId: params.actor.adminUserId,
      actorRole: params.actor.actorRole,
      action: "purge",
      targetType: "group",
      targetId: group.id,
      beforeJson: JSON.stringify({
        messageCount,
        envelopeCount,
        activeMembers,
        lastMessageAt: lastMessage?.createdAt ?? null,
      }),
      afterJson: JSON.stringify(meta),
      ip: params.actor.ip ?? null,
      userAgent: params.actor.userAgent ?? null,
      justification: params.reason ?? null,
    },
  });

  return {
    groupId: group.id,
    name: group.name,
    deletedMessages: deletedMessages.count,
    deletedEnvelopes: deletedEnvelopes.count,
  };
}
