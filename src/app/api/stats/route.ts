import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/stats — compteurs du réseau */
export async function GET() {
  try {
    const [users, posts, dms, channels, likes] = await Promise.all([
      db.user.count(),
      db.post.count(),
      db.directMessage.count(),
      db.post.groupBy({ by: ["geohash"], where: { geohash: { not: null } } }).then((g) => g.length),
      db.like.count(),
    ]);
    return NextResponse.json({ users, posts, dms, channels, likes });
  } catch (e) {
    console.error("GET /api/stats", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
