import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/channels — canaux géohash agrégés (activité) */
export async function GET(req: NextRequest) {
  try {
    const precisionParam = req.nextUrl.searchParams.get("precision");

    const grouped = await db.post.groupBy({
      by: ["geohash", "precision"],
      where: {
        geohash: { not: null },
        ...(precisionParam ? { precision: parseInt(precisionParam, 10) } : {}),
      },
      _count: { _all: true },
      _max: { createdAt: true },
    });

    // participants distincts par canal
    const channels = await Promise.all(
      grouped.map(async (g) => {
        const participants = await db.post.findMany({
          where: { geohash: g.geohash!, precision: g.precision },
          select: { authorId: true },
          distinct: ["authorId"],
        });
        return {
          geohash: g.geohash!,
          precision: g.precision ?? 0,
          postCount: g._count._all,
          participantCount: participants.length,
          lastAt: g._max.createdAt ?? new Date(0),
        };
      })
    );

    channels.sort((a, b) => b.postCount - a.postCount);
    return NextResponse.json({ channels });
  } catch (e) {
    console.error("GET /api/channels", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
