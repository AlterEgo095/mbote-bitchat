import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/follows?followerPub=&targetPub= — est-ce que A suit B ? */
export async function GET(req: NextRequest) {
  try {
    const followerPub = req.nextUrl.searchParams.get("followerPub");
    const targetPub = req.nextUrl.searchParams.get("targetPub");
    if (!followerPub || !targetPub) {
      return NextResponse.json({ error: "followerPub et targetPub requis" }, { status: 400 });
    }
    const following = await db.follow.findFirst({
      where: { follower: { pubkey: followerPub }, following: { pubkey: targetPub } },
    });
    return NextResponse.json({ following: !!following });
  } catch (e) {
    console.error("GET /api/follows", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}

/** POST /api/follows — follow / unfollow */
export async function POST(req: NextRequest) {
  try {
    const { followerPub, targetPub, action } = await req.json();
    if (!followerPub || !targetPub || followerPub === targetPub) {
      return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
    }
    const [follower, target] = await Promise.all([
      db.user.findUnique({ where: { pubkey: followerPub } }),
      db.user.findUnique({ where: { pubkey: targetPub } }),
    ]);
    if (!follower || !target) {
      return NextResponse.json({ error: "Utilisateur introuvable" }, { status: 404 });
    }

    if (action === "unfollow") {
      await db.follow.deleteMany({
        where: { followerId: follower.id, followingId: target.id },
      });
      return NextResponse.json({ following: false });
    }

    await db.follow.upsert({
      where: {
        followerId_followingId: { followerId: follower.id, followingId: target.id },
      },
      update: {},
      create: { followerId: follower.id, followingId: target.id },
    });
    return NextResponse.json({ following: true });
  } catch (e) {
    console.error("POST /api/follows", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
