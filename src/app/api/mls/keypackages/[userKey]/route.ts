import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { unauthorized, verifyGroupProof, rateLimit } from "@/lib/mbote/mls/server";

export const dynamic = "force-dynamic";

// ── C4 — GET /api/mls/keypackages/[userKey] ──────────────────────────────────
// Consommation SINGLE-USE d'un key package frais (RFC 9420 — la clé d'init
// HPKE ne sert qu'une fois). Retourne le plus ancien puis LE SUPPRIME : un
// key package ne peut pas être réutilisé par un second invitant.

const KP_GET_PER_MIN = 20;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userKey: string }> }
) {
  const done = trackApiRequest("mls-keypackages.get");
  try {
    const { userKey } = await params;
    const me = req.nextUrl.searchParams.get("me") ?? "";
    const ts = req.nextUrl.searchParams.get("ts");
    const signature = req.nextUrl.searchParams.get("signature");
    if (!me || !userKey) return unauthorized();
    if (!(await verifyGroupProof(`${me}|mls-kp-get|${userKey}`, me, ts, signature))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "mls-kp-get", KP_GET_PER_MIN, me);
    if (rl) return rl;

    // anti-énumération : 404 uniforme si aucun paquet (même réponse clé absente)
    const kp = await db.mlsKeyPackage.findFirst({
      where: { userKey },
      orderBy: { createdAt: "asc" },
      select: { id: true, keyPackage: true },
    });
    if (!kp) {
      return NextResponse.json({ error: "key package indisponible" }, { status: 404 });
    }
    await db.mlsKeyPackage.delete({ where: { id: kp.id } });
    return NextResponse.json({ keyPackage: kp.keyPackage });
  } catch (e) {
    console.error("GET /api/mls/keypackages/[userKey]", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
