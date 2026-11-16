import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/security — télémétrie sécurité (READ-ONLY)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Un seul endpoint d'AGRÉGATS sur les cinq gardes anti-abus de l'app :
 *
 *   - trustedKeys (A2) : épinglage des clés ECDH des pairs — détection du
 *     CHANGEMENT de clé (state: unverified | verified | changed). Une
 *     montée de « changed » = attaque de substitution de clé ou rotation
 *     anormale ; c'est l'alerte rouge côté client, ici c'est le thermomètre.
 *   - peerBlocks (A3) : blocages utilisateur→utilisateur. Une pointe 24 h
 *     signale un comportement de harcèlement ou une vague de spam.
 *   - replay (A1) : gardes anti-rejeu persistantes (empreinte du tuple
 *     d'identité DM, TTL 7 j) + compteurs de séquence monotones — deux
 *     barrières indépendantes contre le rejeu de messages capturés.
 *   - meshIngest (F-30) : paquets mesh ingérés par les passerelles (dédup
 *     persistante par hash SHA-256). Types : 0x01 announce, 0x02 public,
 *     0x03 dm, 0x04 gossip — la répartition par type montre ce que le mesh
 *     pousse ; hops révèle la profondeur de propagation.
 *   - pow (D2) : challenges PoW consommés (anti-Sybil à la création
 *     d'identité) — le volume 24 h suit les vagues de création de comptes.
 *
 *  READ-ONLY PAR CONSTRUCTION : aucune mutation, aucun paramètre — un
 *  instantané de l'instant (agrégats parallèles Promise.all). Le rôle
 *  « support » suffit (lecture) ; l'auditor reste STRICT (403) — même
 *  arbitrage que les autres annuaires (§13.1 : support = plancher lecture).
 *
 *  PÉRIMÈTRE E2EE : clés publiques, états de confiance, compteurs, hashes
 *  de dédup TRONQUÉS (16 chars — le hash complet d'un DM reconstituerait
 *  un oracle de corrélation), dates. AUCUN contenu, AUCUN tuple DM complet.
 *  ReplayCounter.lastSeq (BigInt) → Number si sûr sinon string. NB : le
 *  hash MeshIngest est tronqué — l'endpoint n'est pas un outil de dédup
 *  inversible (anti-abus de la télémétrie elle-même).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RECENT_LIMIT = 10;

/**
 * BigInt → Number si entier sûr, sinon string — ni perte silencieuse, ni
 * TypeError de sérialisation JSON (BigInt n'y est pas sérialisable).
 */
function bigintToSafe(v: bigint): number | string {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v.toString();
}

/** Tronque un hash à n chars + « … » — jamais le hash complet en réponse. */
function truncateHash(hash: string, n: number): string {
  return `${hash.slice(0, n)}…`;
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.security");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const now = new Date();
    const since24 = new Date(Date.now() - 24 * 3600_000);

    // agrégats PARALLÈLES — chaque garde est interrogée indépendamment
    // (SQLite connection_limit=1 met en file : Promise.all reste correct).
    const [
      tkTotal,
      tkStates,
      tkRecent,
      pbTotal,
      pbLast24h,
      pbRecent,
      rgTotal,
      rgActive,
      rcTotal,
      rcRecent,
      miTotal,
      miLast24h,
      miTypes,
      miRecent,
      powTotal,
      powLast24h,
    ] = await Promise.all([
      db.trustedKey.count(),
      db.trustedKey.groupBy({ by: ["state"], _count: { _all: true } }),
      db.trustedKey.findMany({
        orderBy: { firstSeenAt: "desc" },
        take: RECENT_LIMIT,
        select: { ownerKey: true, peerKey: true, state: true, firstSeenAt: true, verifiedAt: true },
      }),
      db.peerBlock.count(),
      db.peerBlock.count({ where: { createdAt: { gte: since24 } } }),
      db.peerBlock.findMany({
        orderBy: { createdAt: "desc" },
        take: RECENT_LIMIT,
        select: { blockerKey: true, blockedKey: true, createdAt: true },
      }),
      db.replayGuard.count(),
      db.replayGuard.count({ where: { expiresAt: { gt: now } } }),
      db.replayCounter.count(),
      db.replayCounter.findMany({
        orderBy: { updatedAt: "desc" },
        take: RECENT_LIMIT,
        select: { key: true, senderKey: true, lastSeq: true, updatedAt: true },
      }),
      db.meshIngest.count(),
      db.meshIngest.count({ where: { createdAt: { gte: since24 } } }),
      db.meshIngest.groupBy({ by: ["type"], _count: { _all: true } }),
      db.meshIngest.findMany({
        orderBy: { createdAt: "desc" },
        take: RECENT_LIMIT,
        select: { hash: true, gatewayId: true, type: true, hops: true, createdAt: true },
      }),
      db.powSpent.count(),
      db.powSpent.count({ where: { consumedAt: { gte: since24 } } }),
    ]);

    // TrustedKey par état — états du schéma : unverified | verified | changed
    const byState: Record<string, number> = { unverified: 0, verified: 0, changed: 0 };
    for (const row of tkStates) {
      if (row.state in byState) {
        byState[row.state] = row._count._all;
      }
    }

    // MeshIngest par type — types du protocole : 1 announce, 2 public,
    // 3 dm, 4 gossip (clés STRING : les clés JSON numériques sont ambiguës).
    const byType: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0 };
    for (const row of miTypes) {
      const key = String(row.type);
      if (key in byType) {
        byType[key] = row._count._all;
      }
    }

    return NextResponse.json({
      trustedKeys: {
        total: tkTotal,
        byState,
        recent: tkRecent,
      },
      peerBlocks: {
        total: pbTotal,
        last24h: pbLast24h,
        recent: pbRecent,
      },
      replay: {
        guardEntries: rgTotal,
        activeGuardEntries: rgActive,
        expiredGuardEntries: rgTotal - rgActive,
        counters: rcTotal,
        recentCounters: rcRecent.map((r) => ({
          key: r.key,
          senderKey: r.senderKey,
          seq: bigintToSafe(r.lastSeq),
          updatedAt: r.updatedAt,
        })),
      },
      meshIngest: {
        total: miTotal,
        last24h: miLast24h,
        byType,
        recent: miRecent.map((r) => ({
          hash: truncateHash(r.hash, 16),
          gatewayId: r.gatewayId,
          type: r.type,
          hops: r.hops,
          createdAt: r.createdAt,
        })),
      },
      pow: {
        total: powTotal,
        last24h: powLast24h,
      },
      e2ee: true,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/security", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
