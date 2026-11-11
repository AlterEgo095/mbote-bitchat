import { NextRequest, NextResponse } from "next/server";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { verifySignedMessage, READ_MAX_AGE_MS } from "@/lib/mbote/proof";
import { createHmac } from "crypto";

export const dynamic = "force-dynamic";

// ── C2 — GET /api/turn-credentials?me=&ts=&signature= ────────────────────────
// Credentials TURN ÉPHÉMÈRES (TTL 10 min) pour RTCPeerConnection. Deux modes :
//  • PROD (recommandé) : TURN_SHARED_SECRET défini → schéma REST coturn
//    (username = `expiry:pubkey`, credential = base64(HMAC-SHA1(secret, username)))
//    — le serveur coturn validera sans compte pré-créé ; la clé secrète ne
//    quitte JAMAIS le serveur.
//  • SANDBOX/harnais : TURN_STATIC_CREDENTIALS="user:pass" → credentials fixes
//    (serveur node-turn des preuves).
//  • AUCUN des deux → { available: false } — le client passe en mode dégradé
//    (candidates host/srflx only) puis fallback notes vocales après 2 échecs/30 s.
// Lecture authentifiée : preuve `${me}|turn-cred|${ts}` (possession de clé —
// on ne distribue pas des credentials TURN à un anonyme).

const TURN_TTL_SECONDS = 600; // 10 min (directive C2)

/** Construit les credentials REST coturn — pur, testable. */
export function buildRestTurnCredentials(
  sharedSecret: string,
  pubkey: string,
  nowMs: number
): { username: string; credential: string } {
  const expiry = Math.floor(nowMs / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${pubkey}`;
  const credential = createHmac("sha1", sharedSecret).update(username).digest("base64");
  return { username, credential };
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("turn-credentials.get");
  try {
    const sp = req.nextUrl.searchParams;
    const me = sp.get("me") ?? "";
    const ts = sp.get("ts");
    const signature = sp.get("signature");

    const check = await verifySignedMessage({
      message: `${me}|turn-cred|${ts}`,
      pubkey: me,
      ts,
      signature,
      maxAgeMs: READ_MAX_AGE_MS,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve requise : ${check.reason ?? "invalide"}` },
        { status: 401 }
      );
    }

    // rate limit léger : les credentials valent 10 min — pas besoin de les
    // re-demander en boucle (60/min/IP suffit largement au renouvellement)
    const rates = getRateStore();
    const byIp = rates.hit(`turn-cred-ip:${clientIp(req.headers)}`, 60, 60_000);
    if (!byIp.allowed) {
      return NextResponse.json({ error: "Trop de demandes" }, { status: 429 });
    }

    const sharedSecret = process.env.TURN_SHARED_SECRET ?? "";
    const staticCreds = process.env.TURN_STATIC_CREDENTIALS ?? "";
    const urls = (process.env.TURN_URLS ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      // pas de serveur TURN configuré : mode dégradé (ICE host/srflx only)
      return NextResponse.json({
        available: false,
        reason: "TURN non configuré — ICE direct uniquement, fallback notes vocales possible",
      });
    }

    if (sharedSecret) {
      const { username, credential } = buildRestTurnCredentials(sharedSecret, me, Date.now());
      return NextResponse.json({
        available: true,
        urls,
        username,
        credential,
        ttlSeconds: TURN_TTL_SECONDS,
      });
    }

    if (staticCreds) {
      const sep = staticCreds.indexOf(":");
      const username = staticCreds.slice(0, sep);
      const credential = staticCreds.slice(sep + 1);
      if (username.length > 0 && credential.length > 0) {
        return NextResponse.json({
          available: true,
          urls,
          username,
          credential,
          ttlSeconds: TURN_TTL_SECONDS,
          mode: "static",
        });
      }
    }

    return NextResponse.json({ available: false, reason: "TURN mal configuré (secret/credentials absents)" });
  } catch (e) {
    console.error("GET /api/turn-credentials", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
