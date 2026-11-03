import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { followProofMessage, verifySignedMessage } from "@/lib/mbote/proof";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";

export const dynamic = "force-dynamic";

// F-18 : rate limiting sur follow/unfollow (le graphe social est une surface
// de spam : gonfler followers, rafales d'unfollow)
const FOLLOWS_PER_MIN_PER_KEY = 30;
const FOLLOWS_PER_MIN_PER_IP = 90;
const RATE_WINDOW_MS = 60_000;

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
  const done = trackApiRequest("follows.post");
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

    // F-18 : après la preuve (l'usurpateur paie la crypto, le spammeur 429)
    const rates = getRateStore();
    const byKey = rates.hit(`follows:${followerPub}`, FOLLOWS_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`follows-ip:${clientIp(req.headers)}`, FOLLOWS_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop d'abonnements — réessayez plus tard" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
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
  } finally {
    done();
  }
}
