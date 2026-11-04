import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { trustProofMessage, verifySignedMessage } from "@/lib/mbote/proof";
import { trustStatus } from "@/lib/mbote/trust";

export const dynamic = "force-dynamic";

const TRUST_PER_MIN_PER_KEY = 60;
const TRUST_PER_MIN_PER_IP = 180;
const RATE_WINDOW_MS = 60_000;

/** Les deux endpoints exigent une preuve de possession courte durée (F-07 style)
 *  : consulter OU confirmer la confiance d'un pair est un geste authentifié. */
async function requireProof(
  me: unknown,
  ts: unknown,
  signature: unknown,
  message: string
): Promise<NextResponse | null> {
  const check = await verifySignedMessage({
    message,
    pubkey: String(me),
    ts,
    signature,
  });
  if (!check.valid) {
    return NextResponse.json(
      { error: `Preuve de possession refusée : ${check.reason ?? "invalide"}` },
      { status: 401 }
    );
  }
  return null;
}

function rateLimited(me: string, ip: string): NextResponse | null {
  const rates = getRateStore();
  const byKey = rates.hit(`trust:${me}`, TRUST_PER_MIN_PER_KEY, RATE_WINDOW_MS);
  const byIp = rates.hit(`trust-ip:${ip}`, TRUST_PER_MIN_PER_IP, RATE_WINDOW_MS);
  if (!byKey.allowed || !byIp.allowed) {
    return NextResponse.json(
      { error: "Trop de requêtes de confiance — ralentissez" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  return null;
}

/** GET /api/trust?me=&peer=&ts=&signature= — état de confiance + numéro de sécurité
 *
 *  A2 : détecte la SUBSTITUTION de clé (lacune L-3) — si l'`ecdhPub` servi
 *  diverge du dernier épinglé, l'état passe en `changed` (alerte rouge,
 *  envoi E2EE bloqué côté client jusqu'à re-vérification).
 *  La CONFIRMATION hors-bande vit dans POST /api/trust/verify.
 */
export async function GET(req: NextRequest) {
  const done = trackApiRequest("trust.get");
  try {
    const sp = req.nextUrl.searchParams;
    const me = sp.get("me");
    const peer = sp.get("peer");
    if (!me || !peer) {
      return NextResponse.json({ error: "me et peer requis" }, { status: 400 });
    }
    const limited = rateLimited(me, clientIp(req.headers));
    if (limited) return limited;
    const tsNum = Number(sp.get("ts"));
    const unauthorized = await requireProof(
      me,
      sp.get("ts"),
      sp.get("signature"),
      trustProofMessage(me, peer, tsNum)
    );
    if (unauthorized) return unauthorized;

    const meUser = await db.user.findUnique({ where: { pubkey: me }, select: { ecdhPub: true } });
    const trust = await trustStatus(db, {
      me,
      meEcdhPub: meUser?.ecdhPub ?? null,
      peer,
    });
    return NextResponse.json({ trust });
  } catch (e) {
    console.error("GET /api/trust", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
