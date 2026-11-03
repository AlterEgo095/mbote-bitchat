import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPerf, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";

export const dynamic = "force-dynamic";

/** GET /api/stats — compteurs du réseau + santé de performance (Palier 0) */
export async function GET() {
  const done = trackApiRequest("stats.get");
  try {
    const [users, posts, dms, channels, likes, gateways, meshIngest24h] = await Promise.all([
      db.user.count(),
      db.post.count(),
      db.directMessage.count(),
      db.post.groupBy({ by: ["geohash"], where: { geohash: { not: null } } }).then((g) => g.length),
      db.like.count(),
      db.gatewayNode.count(),
      db.meshIngest.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600e3) } } }),
    ]);

    const perf = getPerf().snapshot();
    return NextResponse.json({
      users,
      posts,
      dms,
      channels,
      likes,
      gateways,
      meshIngest24h,
      perf: {
        reqPerSec: perf.reqPerSec,
        p95Ms: perf.p95Ms,
        byRoute: perf.byRoute,
        rateStoreKeys: getRateStore().size(),
      },
      uptimeSec: Math.round(process.uptime()),
    });
  } catch (e) {
    console.error("GET /api/stats", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
