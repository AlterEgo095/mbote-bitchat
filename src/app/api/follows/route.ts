import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { followProofMessage, verifySignedMessage } from "@/lib/mbote/proof";

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

/** POST /api/follows — follow / unfollow
 *  F-01 : preuve de possession obligatoire — signature ECDSA sur
 *  `${followerPub}|follow|${action}|${targetPub}|${ts}`.
 */
export async function POST(req: NextRequest) {
  try {
    const { followerPub, targetPub, action, ts, signature } = await req.json();
    if (!followerPub || !targetPub || followerPub === targetPub) {
      return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
    }
    if (action !== "follow" && action !== "unfollow") {
      return NextResponse.json({ error: "action doit être follow ou unfollow" }, { status: 400 });
    }

    // F-01 : preuve de possession de la clé du follower (avant toute écriture)
    const check = await verifySignedMessage({
      message: followProofMessage(String(followerPub), String(targetPub), action, ts),
      pubkey: String(followerPub),
      ts,
      signature,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve de possession refusée : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
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
