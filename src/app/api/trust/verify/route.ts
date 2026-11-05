import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { trustVerifyProofMessage, verifySignedMessage } from "@/lib/mbote/proof";
import { verifyTrust } from "@/lib/mbote/trust";

export const dynamic = "force-dynamic";

const TRUST_PER_MIN_PER_KEY = 60;
const TRUST_PER_MIN_PER_IP = 180;
const RATE_WINDOW_MS = 60_000;

/** POST /api/trust/verify — confirmation hors-bande du numéro de sécurité (A2)
 *
 *  Le client envoie le numéro qu'il a CALCULÉ LOCALEMENT et comparé en
 *  présentiel — la signature le lie (audit : quel numéro, quand, par qui).
 *  La re-vérification ré-épingle la clé COURANTE du pair et referme l'alerte
 *  rouge (flux « nouvel appareil légitime »).
 */
export async function POST(req: NextRequest) {
  const done = trackApiRequest("trust.verify");
  try {
    const { me, peer, safetyNumber, ts, signature } = await req.json();
    if (!me || !peer || typeof safetyNumber !== "string") {
      return NextResponse.json({ error: "me, peer, safetyNumber requis" }, { status: 400 });
    }
    if (!/^[0-9 ]{59,71}$/.test(safetyNumber)) {
      return NextResponse.json({ error: "format de numéro de sécurité invalide" }, { status: 400 });
    }
    const rates = getRateStore();
    const byKey = rates.hit(`trust:${me}`, TRUST_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`trust-ip:${clientIp(req.headers)}`, TRUST_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      return NextResponse.json(
        { error: "Trop de requêtes de confiance — ralentissez" },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }
    const check = await verifySignedMessage({
      message: trustVerifyProofMessage(String(me), String(peer), safetyNumber, Number(ts)),
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

    const meUser = await db.user.findUnique({ where: { pubkey: me }, select: { ecdhPub: true } });
    const trust = await verifyTrust(db, {
      me,
      meEcdhPub: meUser?.ecdhPub ?? null,
      peer,
      number: safetyNumber,
    });
    return NextResponse.json({ trust });
  } catch (e) {
    if (e instanceof Error && e.message.includes("sans clé ECDH")) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    console.error("POST /api/trust/verify", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
