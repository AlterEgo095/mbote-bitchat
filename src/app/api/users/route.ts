import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/users — liste des identités enregistrées (contacts DM, favoris) */
export async function GET(req: NextRequest) {
  try {
    const exclude = req.nextUrl.searchParams.get("exclude");
    const users = await db.user.findMany({
      where: exclude ? { pubkey: { not: exclude } } : undefined,
      orderBy: [{ isBot: "desc" }, { nickname: "asc" }],
      include: {
        _count: { select: { posts: true, followers: true, following: true } },
      },
      take: 100,
    });
    return NextResponse.json({ users });
  } catch (e) {
    console.error("GET /api/users", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
