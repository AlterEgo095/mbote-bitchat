import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/network — graphe social (read-only, D2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Vue d'ensemble du GRAPHE DE CONFIANCE (Follow — « favoris mutuels ») et
 *  des CRÉDITS de follow (D2 anti-Sybil) :
 *
 *   - follow.total / last24h : volume d'arêtes dirigées (A suit B) ;
 *   - mutualPairs : paires A→B ET B→A comptées UNE fois — SQL : chaque
 *     follow réciproque n'est compté qu'avec son extrémité canonique
 *     (followerId < followingId, l'arête A→A n'existe pas par construction),
 *     pas de halving approximatif ;
 *   - topFollowed : 10 comptes les plus suivis (LEFT JOIN User pour le
 *     nickname — un follow orphelin reste compté, pubkey fallback = id) ;
 *   - recent : 10 derniers follows (nicknames des deux extrémités si
 *     résolues) ;
 *   - credits : FollowCredit (D2) — LECTURE DU SCHÉMA : le modèle n'a PAS
 *     de colonne de montant ; la ligne EST le crédit (un follow ne crédite
 *     +1 qu'UNE fois par paire et la ligne survit à l'unfollow pour empêcher
 *     le farming). Donc : total = nombre de lignes, sum = somme des crédits
 *     = même valeur par construction (1 ligne = 1 crédit) — les deux sont
 *     exposés pour garder le contrat d'agrégat explicite.
 *
 *  READ-ONLY : aucun paramètre, aucune mutation, aucun cursor — l'instantané
 *  du graphe suffit au panneau (santé réseau, détection de fermes de
 *  followers : pics last24h, concentration topFollowed). minRole "support"
 *  (lecture) ; l'auditor reste STRICT (403).
 *
 *  PÉRIMÈTRE E2EE : follows/credits sont des métadonnées de graphe PUBLIQUES
 *  par conception (profils publics) — noms publics + clés publiques + dates.
 *  AUCUN contenu de message, AUCUN ciphertext (invariant §1.4 ADMIN-RBAC).
 *  SQL brut paramétré (?) uniquement ; COUNT → BigInt → Number().
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TOP_FOLLOWED_LIMIT = 10;
const RECENT_LIMIT = 10;

interface RawCountRow {
  n: bigint;
}

interface RawTopRow {
  /** COALESCE(u.pubkey, f.followingId) — expression sans decltype → string */
  pubkey: string;
  nickname: string | null;
  followers: bigint;
}

interface RawRecentRow {
  followerKey: string;
  followerNickname: string | null;
  followingKey: string;
  followingNickname: string | null;
  createdAt: Date;
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.network");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const since24 = new Date(Date.now() - 24 * 3600_000);

    const [followTotal, followLast24h, mutualRows, topRows, recentRows, creditTotal] =
      await Promise.all([
        db.follow.count(),
        db.follow.count({ where: { createdAt: { gte: since24 } } }),
        // paires MUTUELLES comptées une fois : seule l'extrémité canonique
        // (followerId < followingId) teste la réciproque — l'arête A→A
        // n'existe pas (pas d'auto-follow dans l'endpoint) et une paire
        // mutuelle (A<B) est testée exactement une fois depuis A.
        db.$queryRawUnsafe<Array<RawCountRow>>(
          `SELECT COUNT(*) AS n
           FROM Follow f1
           WHERE f1.followerId < f1.followingId
             AND EXISTS (
               SELECT 1 FROM Follow f2
               WHERE f2.followerId = f1.followingId AND f2.followingId = f1.followerId
             )`
        ),
        db.$queryRawUnsafe<Array<RawTopRow>>(
          `SELECT COALESCE(u.pubkey, f.followingId) AS pubkey, u.nickname AS nickname,
                  COUNT(*) AS followers
           FROM Follow f
           LEFT JOIN User u ON u.id = f.followingId
           GROUP BY f.followingId
           ORDER BY COUNT(*) DESC, f.followingId ASC
           LIMIT ${TOP_FOLLOWED_LIMIT}`
        ),
        db.$queryRawUnsafe<Array<RawRecentRow>>(
          `SELECT COALESCE(u1.pubkey, f.followerId) AS followerKey,
                  u1.nickname AS followerNickname,
                  COALESCE(u2.pubkey, f.followingId) AS followingKey,
                  u2.nickname AS followingNickname,
                  f.createdAt
           FROM Follow f
           LEFT JOIN User u1 ON u1.id = f.followerId
           LEFT JOIN User u2 ON u2.id = f.followingId
           ORDER BY f.createdAt DESC
           LIMIT ${RECENT_LIMIT}`
        ),
        db.followCredit.count(),
      ]);

    return NextResponse.json({
      follow: {
        total: followTotal,
        mutualPairs: Number(mutualRows[0]?.n ?? 0),
        last24h: followLast24h,
        topFollowed: topRows.map((r) => ({
          pubkey: r.pubkey,
          nickname: r.nickname,
          followers: Number(r.followers),
        })),
        recent: recentRows.map((r) => ({
          followerKey: r.followerKey,
          followerNickname: r.followerNickname,
          followingKey: r.followingKey,
          followingNickname: r.followingNickname,
          createdAt: r.createdAt,
        })),
      },
      credits: {
        // 1 ligne FollowCredit = 1 crédit crédité une fois par paire (D2 :
        // la ligne survit à l'unfollow) → sum == total par construction.
        total: creditTotal,
        sum: creditTotal,
      },
      e2ee: true,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/network", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
