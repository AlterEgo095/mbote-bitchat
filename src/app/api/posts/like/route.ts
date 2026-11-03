import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { likeProofMessage, verifySignedMessage } from "@/lib/mbote/proof";

export const dynamic = "force-dynamic";

const LIKES_PER_MIN_PER_KEY = 60;
const RATE_WINDOW_MS = 60_000;

/** POST /api/posts/like — bascule j'aime
 *  Compteur dénormalisé (D5) : like + incrément du compteur dans UNE transaction
 *  atomique — plus aucun COUNT à chaud, plus jamais de compteur désynchronisé.
 *  F-01 : preuve de possession obligatoire — signature ECDSA sur
 *  `${pubkey}|like|${postId}|${ts}` → un like est attribuable à son auteur réel.
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("posts.like");
  try {
    const { pubkey, postId, ts, signature } = await req.json();
    if (!pubkey || !postId) {
      return NextResponse.json({ error: "pubkey et postId requis" }, { status: 400 });
    }

    // F-01 : preuve de possession de la clé (avant toute écriture)
    const check = await verifySignedMessage({
      message: likeProofMessage(String(pubkey), String(postId), ts),
      pubkey: String(pubkey),
      ts,
      signature,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve de possession refusée : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    // rate limit anti-spam (marteau sur le bouton cœur)
    const rates = getRateStore();
    const verdict = rates.hit(
      `like:${pubkey}:${clientIp(req.headers)}`,
      LIKES_PER_MIN_PER_KEY,
      RATE_WINDOW_MS
    );
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: "Trop de requêtes — ralentissez" },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }

    const user = await db.user.findUnique({ where: { pubkey } });
    const post = await db.post.findUnique({ where: { id: postId } });
    if (!user || !post) {
      return NextResponse.json({ error: "Utilisateur ou post introuvable" }, { status: 404 });
    }

    const existing = await db.like.findUnique({
      where: { postId_userId: { postId, userId: user.id } },
    });

    const result = await db.$transaction(async (tx) => {
      if (existing) {
        await tx.like.delete({ where: { id: existing.id } });
        const updated = await tx.post.update({
          where: { id: postId },
          data: { likeCount: { decrement: 1 } },
          select: { likeCount: true },
        });
        return { liked: false, likeCount: Math.max(0, updated.likeCount) };
      }
      await tx.like.create({ data: { postId, userId: user.id } });
      const updated = await tx.post.update({
        where: { id: postId },
        data: { likeCount: { increment: 1 } },
        select: { likeCount: true },
      });
      return { liked: true, likeCount: updated.likeCount };
    });

    relayNotify(
      "post:like",
      { postId, likeCount: result.likeCount, liked: result.liked, pubkey },
      ["feed"]
    );
    return NextResponse.json(result);
  } catch (e) {
    console.error("POST /api/posts/like", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
