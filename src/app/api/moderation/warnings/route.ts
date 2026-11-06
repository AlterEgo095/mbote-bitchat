import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { isValidPubkeyFormat, READ_FUTURE_TOLERANCE_MS, READ_MAX_AGE_MS, verifySignedMessage } from "@/lib/mbote/proof";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/moderation/warnings?me=&ts=&signature= — mes avertissements
 *  (ADM Étape 6 — directive : « notification côté app utilisateur, visible
 *  dans son profil, pas de DM pour rester E2EE »)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Écrits par l'action `warn` (UserWarning, migration 0006). Lus par leur
 *  TITULAIRE UNIQUEMENT : preuve de possession ECDSA courte durée sur la
 *  chaîne canonique `${me}|warnings-read|${ts}` (même mécanique que la
 *  lecture DM F-07 — READ_MAX_AGE_MS). Impossible de lire les avertissements
 *  d'autrui (401 sans preuve valide).
 *
 *  Payload minimal : catégorie (enum fermé §6), note (texte de justification
 *  adressé à l'utilisateur), date. Aucune identité d'admin (l'acteur reste
 *  visible dans l'audit admin, pas ici), aucune IP, aucun contenu de DM
 *  (invariant §1.4 — aucune modération DM par conception).
 *
 *  Rate limit : 30 / min / clé et 60 / min / IP (même profil que les
 *  lectures DM — surface de lecture utilisateur, pas d'écriture).
 */

const WARNINGS_PER_MIN_PER_KEY = 30;
const WARNINGS_PER_MIN_PER_IP = 60;
const RATE_WINDOW_MS = 60_000;

function warningsReadProofMessage(me: string, ts: number): string {
  return `${me}|warnings-read|${ts}`;
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("moderation.warnings");
  try {
    const sp = req.nextUrl.searchParams;
    const me = sp.get("me");
    const ts = Number(sp.get("ts"));
    const signature = sp.get("signature");
    if (!me || !isValidPubkeyFormat(me)) {
      return NextResponse.json(
        { error: "me invalide (clé publique P-256 brute base64url attendue)" },
        { status: 400 }
      );
    }

    // rate limit AVANT la vérification cryptographique (F-18)
    const rates = getRateStore();
    const byKey = rates.hit(`warnings-read:${me}`, WARNINGS_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byIp = rates.hit(`warnings-read-ip:${clientIp(req.headers)}`, WARNINGS_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop de lectures — ralentissez" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

    // preuve de possession : je ne rends les avertissements qu'à leur titulaire
    const check = await verifySignedMessage({
      message: warningsReadProofMessage(me, ts),
      pubkey: me,
      ts,
      signature,
      maxAgeMs: READ_MAX_AGE_MS,
      futureToleranceMs: READ_FUTURE_TOLERANCE_MS,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Lecture refusée (preuve requise) : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    const user = await db.user.findUnique({ where: { pubkey: me }, select: { id: true } });
    if (!user) {
      // identité inconnue = aucun avertissement possible
      return NextResponse.json({ warnings: [] });
    }
    const warnings = await db.userWarning.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, category: true, note: true, createdAt: true },
      take: 50,
    });
    return NextResponse.json({ warnings });
  } catch (e) {
    console.error("GET /api/moderation/warnings", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
