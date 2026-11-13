import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import {
  readJson,
  unauthorized,
  verifyGroupProof,
  rateLimit,
  MLS_KEYPACKAGE_MAX,
} from "@/lib/mbote/mls/server";

export const dynamic = "force-dynamic";

// ── C4 — POST /api/mls/keypackages ───────────────────────────────────────────
// Publication de key packages MLS FRAIS (RFC 9420 §12.4.1.5). Le contenu est
// PUBLIC (clés HPKE + signature + credential) — pas de secret ici ; les clés
// privées correspondantes restent dans le coffre du client. Prune douce : ≤ 3
// paquets disponibles par utilisateur (les consommations les retirent).

const KP_PUBLISH_PER_MIN = 10;

export async function POST(req: NextRequest) {
  const done = trackApiRequest("mls-keypackages.post");
  try {
    const body = await readJson(req);
    const me = typeof body.me === "string" ? body.me : "";
    if (!me) return unauthorized();
    if (!(await verifyGroupProof(`${me}|mls-kp`, me, body.ts, body.signature))) {
      return unauthorized();
    }
    const rl = rateLimit(req, "mls-kp", KP_PUBLISH_PER_MIN, me);
    if (rl) return rl;

    const keyPackage = typeof body.keyPackage === "string" ? body.keyPackage : "";
    if (!keyPackage || keyPackage.length > MLS_KEYPACKAGE_MAX) {
      return NextResponse.json({ error: "keyPackage requis (≤ 8 Ko)" }, { status: 400 });
    }

    await db.mlsKeyPackage.create({
      data: { userKey: me, keyPackage },
    });
    // prune douce : garder les 3 plus récents de l'utilisateur.
    // EXCEPTION §4d DOCUMENTÉE (vague durcissement — écart accepté) : create
    // (l'écriture essentielle) et prune (ramassage périodique) restent hors
    // transaction — une coupe entre les deux laisse des keypackages
    // excédentaires, état SANS risque (ils restent valides, single-use) et
    // AUTO-RATTRAPÉ au publish suivant (prune rejouée). Retrier un échec de
    // prune dans une tx ne ferait que prolonger la tenue du verrou.
    const extras = await db.mlsKeyPackage.findMany({
      where: { userKey: me },
      orderBy: { createdAt: "desc" },
      skip: 3,
      select: { id: true },
    });
    if (extras.length > 0) {
      await db.mlsKeyPackage.deleteMany({ where: { id: { in: extras.map((e) => e.id) } } });
    }
    return NextResponse.json({ accepted: true }, { status: 201 });
  } catch (e) {
    console.error("POST /api/mls/keypackages", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
