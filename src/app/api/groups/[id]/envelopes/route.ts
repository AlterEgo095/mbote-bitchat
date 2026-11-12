import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { unauthorized, verifyGroupProof, rateLimit, isActiveMember } from "@/lib/mbote/mls/server";
import { trackApiRequest } from "@/lib/mbote/state-store";

export const dynamic = "force-dynamic";

// ── C4 — GET /api/groups/[id]/envelopes ──────────────────────────────────────
// Enveloppes de handshake MLS pendues pour CE membre : commits (diffusion à
// tous) + welcomes ciblés. ORDRE STRICT (chaque commit avance l'epoch — le
// client traite séquentiellement). Le payload est un binaire MLS opaque.

const ENV_PER_MIN = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("groups.envelopes");
  try {
    const { id } = await params;
    const sp = req.nextUrl.searchParams;
    const me = sp.get("me") ?? "";
    if (!me) return unauthorized();
    if (!(await verifyGroupProof(`${me}|group-env|${id}`, me, sp.get("ts"), sp.get("signature")))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "group-env", ENV_PER_MIN, me);
    if (rl) return rl;

    // hors du groupe (ou exclu) → liste vide uniforme (pas d'information)
    if (!(await isActiveMember(id, me))) {
      return NextResponse.json({ envelopes: [] });
    }

    const rows = await db.groupEnvelope.findMany({
      where: {
        groupId: id,
        OR: [{ targetKey: null }, { targetKey: me }],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, targetKey: true, payload: true, createdAt: true },
    });
    return NextResponse.json({
      envelopes: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        targetKey: r.targetKey,
        payload: r.payload,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    console.error("GET /api/groups/[id]/envelopes", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
