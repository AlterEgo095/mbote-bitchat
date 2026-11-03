import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toUserDto } from "@/lib/mbote/dto";

export const dynamic = "force-dynamic";

/** GET /api/users — liste des identités enregistrées (contacts DM, favoris)
 *  F-12 : query param optionnel `me` (pubkey) → chaque user est annoté d'un
 *  booléen `isFollowing` (« est-ce que `me` suit cet user ? »). L'annotation
 *  se fait en UN SEUL findMany sur Follow (followerId + followingId in ids) —
 *  pas de N+1. Champ additionnel : réponse rétrocompatible (`users` inchangé).
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const exclude = sp.get("exclude");
    const mePub = sp.get("me");
    const users = await db.user.findMany({
      where: exclude ? { pubkey: { not: exclude } } : undefined,
      orderBy: [{ isBot: "desc" }, { nickname: "asc" }],
      include: {
        _count: { select: { posts: true, followers: true, following: true } },
      },
      take: 100,
    });

    // Annotation isFollowing : mappe pubkey→id de `me`, puis un seul findMany
    // sur la table Follow borné aux ids affichés (2 requêtes au total).
    let followedIds = new Set<string>();
    if (mePub && users.length > 0) {
      const me = await db.user.findUnique({
        where: { pubkey: mePub },
        select: { id: true },
      });
      if (me) {
        const follows = await db.follow.findMany({
          where: { followerId: me.id, followingId: { in: users.map((u) => u.id) } },
          select: { followingId: true },
        });
        followedIds = new Set(follows.map((f) => f.followingId));
      }
    }

    return NextResponse.json({
      users: users.map((u) => ({ ...toUserDto(u), isFollowing: followedIds.has(u.id) })),
    });
  } catch (e) {
    console.error("GET /api/users", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
