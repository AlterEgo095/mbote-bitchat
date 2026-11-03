import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseGeohashPrecision } from "@/lib/mbote/params";

export const dynamic = "force-dynamic";

/** GET /api/channels — canaux géohash agrégés (activité) */
export async function GET(req: NextRequest) {
  try {
    const precisionRaw = req.nextUrl.searchParams.get("precision");
    let precision: number | undefined;
    if (precisionRaw != null) {
      const parsed = parseGeohashPrecision(precisionRaw);
      if (parsed == null) {
        return NextResponse.json({ error: "precision invalide (1..12)" }, { status: 400 });
      }
      precision = parsed;
    }

    const grouped = await db.post.groupBy({
      by: ["geohash", "precision"],
      where: {
        geohash: { not: null },
        ...(precision != null ? { precision } : {}),
      },
      _count: { _all: true },
      _max: { createdAt: true },
    });

    // F-45 : participants distincts — UNE seule requête bornée aux canaux
    // affichés (distinct geohash+precision+authorId), puis regroupés en mémoire.
    const targets = grouped.filter(
      (g): g is typeof g & { geohash: string } => g.geohash != null
    );
    const authorRows =
      targets.length === 0
        ? []
        : await db.post.findMany({
            where: {
              OR: targets.map((g) => ({ geohash: g.geohash, precision: g.precision })),
            },
            select: { geohash: true, precision: true, authorId: true },
            distinct: ["geohash", "precision", "authorId"],
          });
    const participantsByKey = new Map<string, number>();
    for (const r of authorRows) {
      const key = `${r.geohash}|${r.precision ?? ""}`;
      participantsByKey.set(key, (participantsByKey.get(key) ?? 0) + 1);
    }

    const channels = targets.map((g) => ({
      geohash: g.geohash,
      precision: g.precision ?? 0,
      postCount: g._count._all,
      participantCount: participantsByKey.get(`${g.geohash}|${g.precision ?? ""}`) ?? 0,
      lastAt: g._max.createdAt ?? new Date(0),
    }));

    channels.sort((a, b) => b.postCount - a.postCount);
    return NextResponse.json({ channels });
  } catch (e) {
    console.error("GET /api/channels", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
