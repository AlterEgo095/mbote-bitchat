import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifySignedMessage } from "@/lib/mbote/proof";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/push/subscribe — enregistrement Web Push (C1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  AUTH = preuve de possession (même mécanique que /api/dms) — chaîne
 *  canonique `${me}|push-sub|${endpoint}|${p256dh}|${auth}|${ts}` signée ECDSA
 *  par la clé de l'utilisateur. maxAge = fenêtre action (7 j, comme les
 *  autres actions signées — tranché : cohérent, le rate limite l'abus).
 *
 *  UPSERT idempotent par ENDPOINT (unique — directive) : re-subscrire la même
 *  subscription (rotations de SW, re-installs PWA) met à jour les keys et
 *  RÉACTIVE (disabledAt ← null) — 2 appels = 1 ligne (testé).
 *
 *  RATE LIMIT : 10 subscriptions / heure / user (directive) + garde IP.
 *  AUCUN contenu dans cette table : endpoint + clés de chiffrement du
 *  navigateur uniquement (RFC 8291 — le serveur chiffre le knock mais ne
 *  peut pas le déchiffrer lui-même : les clés p256dh/auth chiffrent le
 *  payload vers le push service, pas de contenu dedans).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SUBSCRIBE_PER_HOUR = 10;
const RATE_WINDOW_MS = 3600_000;

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  const done = trackApiRequest("push.subscribe");
  try {
    const body = (await req.json().catch(() => null)) as
      | { me?: unknown; endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; ts?: unknown; signature?: unknown; userAgent?: unknown }
      | null;
    if (!body) return bad(400, "corps illisible (JSON attendu)");

    const me = typeof body.me === "string" ? body.me : "";
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
    const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
    if (!me || !endpoint || !p256dh || !auth) {
      return bad(400, "me, endpoint, keys.p256dh et keys.auth requis");
    }
    if (endpoint.length > 2000 || p256dh.length > 512 || auth.length > 512) {
      return bad(400, "champs de subscription trop longs (endpoint ≤ 2000, keys ≤ 512)");
    }
    const userAgent = typeof body.userAgent === "string" ? body.userAgent.slice(0, 300) : null;

    // AUTH : preuve de possession de la clé `me` (anti-spam d'abonnements tiers)
    const check = await verifySignedMessage({
      message: `${me}|push-sub|${endpoint}|${p256dh}|${auth}|${body.ts as number}`,
      pubkey: me,
      ts: body.ts,
      signature: body.signature,
    });
    if (!check.valid) {
      return bad(401, `Preuve de possession refusée : ${check.reason ?? "invalide"}`);
    }

    // l'utilisateur doit exister (clé publiée — cohérence avec /api/dms)
    const user = await db.user.findUnique({ where: { pubkey: me }, select: { pubkey: true } });
    if (!user) return bad(404, "Identité inconnue (clé non enregistrée)");

    // RATE LIMIT : 10/h/user (directive) + garde IP
    const rates = getRateStore();
    const byKey = rates.hit(`push-sub:${me}`, SUBSCRIBE_PER_HOUR, RATE_WINDOW_MS);
    const byIp = rates.hit(`push-sub-ip:${clientIp(req.headers)}`, 30, RATE_WINDOW_MS);
    if (!byKey.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop d'abonnements — ralentissez" },
        { status: 429, headers: { "Retry-After": String(retry || 3600) } }
      );
    }

    // UPSERT par endpoint (idempotent — 2 appels = 1 ligne)
    const sub = await db.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: me, endpoint, keysP256dh: p256dh, keysAuth: auth, userAgent },
      update: {
        // le endpoint peut être RE-ENREGISTRÉ par un autre compte (ex : même
        // navigateur, identité remplacée) — le propriétaire suit la dernière
        // preuve valide
        userId: me,
        keysP256dh: p256dh,
        keysAuth: auth,
        userAgent,
        disabledAt: null, // re-subscribe = RÉACTIVATION
        lastSeenAt: new Date(),
      },
      select: { id: true, endpoint: true, disabledAt: true },
    });

    return NextResponse.json({
      subscription: { id: sub.id, endpoint: sub.endpoint, active: sub.disabledAt === null },
    });
  } catch (e) {
    console.error("POST /api/push/subscribe", e);
    return bad(500, "Erreur serveur");
  } finally {
    done();
  }
}
