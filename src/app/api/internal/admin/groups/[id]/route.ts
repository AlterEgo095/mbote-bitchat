import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/groups/[id] — fiche complète d'un groupe MLS (C4)
 *  (back-office 2026-11 : diagnostic E2EE — métadonnées uniquement)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Réponse : fiche du groupe (annuaire + compteurs) + MEMBRES (join/leave —
 *  visibles par DÉFINITION : le serveur tient l'annuaire, spec C4) + 50
 *  derniers MESSAGES + 20 dernières ENVELOPPES de handshake.
 *
 *  PÉRIMÈTRE E2EE STRICT : GroupMessage.ciphertext et GroupEnvelope.payload
 *  sont des ciphertext MLS OPAQUES — AUCUN n'est renvoyé. Les messages et
 *  enveloppes n'exposent que : id, expéditeur/destinataire (clés publiques),
 *  epoch MLS, date et LONGUEUR (LENGTH SQL — jamais le contenu, jamais d'iv).
 *  Le diagnostic serveur s'arrête LÀ : déchiffrer est impossible par
 *  construction (relais aveugle, invariant §1.4 ADMIN-RBAC.md).
 *
 *  MLS EPOCH : mlsEpoch est un BigInt Prisma — converti prudemment :
 *  Number() si ≤ Number.MAX_SAFE_INTEGER, sinon .toString() (jamais de
 *  perte silencieuse, jamais de BigInt sérialisé en JSON — TypeError).
 *
 *  AUTH : requireAdmin({minRole:"support"}) — lecture ; l'auditor reste
 *  STRICT (403). GET → pas de CSRF. 404 si le groupe est absent (purgé en
 *  cascade — les traces restent dans AdminAudit, visibles via /audit).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const MEMBERS_LIMIT = 200;
const MESSAGES_LIMIT = 50;
const ENVELOPES_LIMIT = 20;

/**
 * BigInt → Number si entier sûr, sinon string — ni perte silencieuse
 * (Number > 2^53−1 arrondit), ni crash de sérialisation JSON (BigInt n'y
 * est pas sérialisable). Utilisé pour mlsEpoch.
 */
function bigintToSafe(v: bigint): number | string {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v.toString();
}

interface RawGroupAggRow {
  memberCount: bigint;
  activeMemberCount: bigint;
  messageCount: bigint;
  envelopeCount: bigint;
  /** MAX(createdAt) — BigInt (expression sans decltype) ou null */
  lastMessageAt: bigint | null;
}

interface RawMessageRow {
  id: string;
  senderKey: string;
  mlsEpoch: bigint;
  createdAt: Date;
  /** LENGTH(ciphertext) — expression → BigInt (longueur du ciphertext,
   *  JAMAIS son contenu) */
  bytes: bigint;
}

interface RawEnvelopeRow {
  id: string;
  kind: string;
  targetKey: string | null;
  createdAt: Date;
  /** LENGTH(payload) — expression → BigInt (longueur, JAMAIS le contenu) */
  bytes: bigint;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.groups.detail");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const { id } = await params;
    if (!id || id.length === 0 || id.length > 128) {
      return NextResponse.json({ error: "id invalide" }, { status: 400 });
    }

    const group = await db.group.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        mlsGroupId: true,
        creatorKey: true,
        createdAt: true,
        updatedAt: true,
      },
    }).catch(() => null);

    if (!group) {
      return NextResponse.json(
        { error: "Groupe introuvable (ou purgé — voir l'audit)" },
        { status: 404 }
      );
    }

    // Compteurs du groupe — sous-requêtes scalaires ; COUNT/MAX → BigInt.
    const aggRows = await db.$queryRawUnsafe<Array<RawGroupAggRow>>(
      `SELECT
         (SELECT COUNT(*) FROM GroupMember WHERE groupId = ?) AS memberCount,
         (SELECT COUNT(*) FROM GroupMember WHERE groupId = ? AND leftAt IS NULL) AS activeMemberCount,
         (SELECT COUNT(*) FROM GroupMessage WHERE groupId = ?) AS messageCount,
         (SELECT COUNT(*) FROM GroupEnvelope WHERE groupId = ?) AS envelopeCount,
         (SELECT MAX(createdAt) FROM GroupMessage WHERE groupId = ?) AS lastMessageAt`,
      id,
      id,
      id,
      id,
      id
    );
    const agg = aggRows[0];

    // Annuaire des membres : join/leave visibles par définition (l'état
    // TreeKEM réel vit côté client — mlsLeafIndex est un diagnostic d'ajout).
    const members = await db.groupMember.findMany({
      where: { groupId: id },
      orderBy: { joinedAt: "asc" },
      take: MEMBERS_LIMIT,
      select: {
        userKey: true,
        joinedAt: true,
        leftAt: true,
        mlsLeafIndex: true,
      },
    });

    // 50 derniers messages — MÉTADONNÉES uniquement : LENGTH() en SQL,
    // le ciphertext n'est JAMAIS sélectionné.
    const messageRows = await db.$queryRawUnsafe<Array<RawMessageRow>>(
      `SELECT id, senderKey, mlsEpoch, createdAt, LENGTH(ciphertext) AS bytes
       FROM GroupMessage
       WHERE groupId = ?
       ORDER BY createdAt DESC
       LIMIT ${MESSAGES_LIMIT}`,
      id
    );

    // 20 dernières enveloppes de handshake (commits/welcomes) — idem :
    // LENGTH() du payload, jamais le payload.
    const envelopeRows = await db.$queryRawUnsafe<Array<RawEnvelopeRow>>(
      `SELECT id, kind, targetKey, createdAt, LENGTH(payload) AS bytes
       FROM GroupEnvelope
       WHERE groupId = ?
       ORDER BY createdAt DESC
       LIMIT ${ENVELOPES_LIMIT}`,
      id
    );

    return NextResponse.json({
      group: {
        id: group.id,
        name: group.name,
        mlsGroupId: group.mlsGroupId,
        creatorKey: group.creatorKey,
        memberCount: Number(agg?.memberCount ?? 0),
        activeMemberCount: Number(agg?.activeMemberCount ?? 0),
        messageCount: Number(agg?.messageCount ?? 0),
        envelopeCount: Number(agg?.envelopeCount ?? 0),
        lastMessageAt:
          agg?.lastMessageAt !== undefined && agg?.lastMessageAt !== null
            ? new Date(Number(agg.lastMessageAt))
            : null,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      },
      members,
      recentMessages: messageRows.map((r) => ({
        id: r.id,
        senderKey: r.senderKey,
        mlsEpoch: bigintToSafe(r.mlsEpoch),
        createdAt: r.createdAt,
        bytes: Number(r.bytes),
      })),
      recentEnvelopes: envelopeRows.map((r) => ({
        id: r.id,
        kind: r.kind,
        targetKey: r.targetKey,
        createdAt: r.createdAt,
        bytes: Number(r.bytes),
      })),
      e2ee: true,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/groups/[id]", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
