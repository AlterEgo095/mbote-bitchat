import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { relayNotify } from "@/lib/mbote/relay-notify";

export const dynamic = "force-dynamic";

/** POST /api/posts/like — bascule j'aime */
export async function POST(req: NextRequest) {
  try {
    const { pubkey, postId } = await req.json();
    if (!pubkey || !postId) {
      return NextResponse.json({ error: "pubkey et postId requis" }, { status: 400 });
    }

    const user = await db.user.findUnique({ where: { pubkey } });
    const post = await db.post.findUnique({ where: { id: postId } });
    if (!user || !post) {
      return NextResponse.json({ error: "Utilisateur ou post introuvable" }, { status: 404 });
    }

    const existing = await db.like.findUnique({
      where: { postId_userId: { postId, userId: user.id } },
    });

    if (existing) {
      await db.like.delete({ where: { id: existing.id } });
    } else {
      await db.like.create({ data: { postId, userId: user.id } });
    }

    const likeCount = await db.like.count({ where: { postId } });
    relayNotify("post:like", { postId, likeCount, liked: !existing, pubkey }, ["feed"]);
    return NextResponse.json({ liked: !existing, likeCount });
  } catch (e) {
    console.error("POST /api/posts/like", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
