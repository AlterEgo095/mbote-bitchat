import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, getRateStore, trackApiRequest } from "@/lib/mbote/state-store";
import { verifySignedMessage, READ_MAX_AGE_MS } from "@/lib/mbote/proof";
import { sendPushToUser } from "@/lib/mbote/push/sender";

export const dynamic = "force-dynamic";

// ── C2 — POST /api/call-knock ────────────────────────────────────────────────
// Knock SANS CONTENU pour appel entrant (type: "incoming_call", payload
// { type, fromLabel } strict — E2EE oblige, identique à C1) : le push réveille
// le callee ABSENT du hub (PWA fermée / écran éteint). Le callee EN LIGNE
// reçoit la signalisation socket.io call:offer en parallèle.
// Anti-abus : preuve ECDSA `${from}|call-knock|${to}|${callId}|${ts}` + rate
// limit strict (6/min par appelant, 20/min par destinataire) + existence du
// destinataire (pas de knock vers l'inconnu) + fire-and-forget (jamais bloquant).

const KNOCK_PER_MIN_PER_KEY = 6;
const KNOCK_PER_MIN_PER_TARGET = 20;
const RATE_WINDOW_MS = 60_000;

export async function POST(req: NextRequest) {
  const done = trackApiRequest("call-knock.post");
  try {
    const body = (await req.json().catch(() => ({}))) as {
      from?: unknown;
      to?: unknown;
      callId?: unknown;
      ts?: unknown;
      signature?: unknown;
    };
    const from = typeof body.from === "string" ? body.from : "";
    const to = typeof body.to === "string" ? body.to : "";
    const callId = typeof body.callId === "string" ? body.callId : "";

    if (!from || !to || callId.length < 8 || callId.length > 64) {
      return NextResponse.json({ error: "from/to/callId requis" }, { status: 400 });
    }

    const check = await verifySignedMessage({
      message: `${from}|call-knock|${to}|${callId}|${body.ts}`,
      pubkey: from,
      ts: body.ts,
      signature: body.signature,
      maxAgeMs: READ_MAX_AGE_MS,
    });
    if (!check.valid) {
      return NextResponse.json(
        { error: `Preuve invalide : ${check.reason ?? "signature refusée"}` },
        { status: 401 }
      );
    }

    // rate limit : par appelant ET par destinataire (anti-spam knock)
    const rates = getRateStore();
    const byKey = rates.hit(`call-knock:${from}`, KNOCK_PER_MIN_PER_KEY, RATE_WINDOW_MS);
    const byTarget = rates.hit(`call-knock-to:${to}`, KNOCK_PER_MIN_PER_TARGET, RATE_WINDOW_MS);
    const byIp = rates.hit(`call-knock-ip:${clientIp(req.headers)}`, 30, RATE_WINDOW_MS);
    if (!byKey.allowed || !byTarget.allowed || !byIp.allowed) {
      const retry = Math.ceil(Math.max(byKey.retryAfterMs, byTarget.retryAfterMs, byIp.retryAfterMs) / 1000);
      return NextResponse.json(
        { error: "Trop de knocks — ralentissez" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

    // le destinataire existe (pas de knock vers l'inconnu — n'énumère rien :
    // la réponse est identique 202 dans tous les cas)
    const target = await db.user.findUnique({
      where: { pubkey: to },
      select: { nickname: true },
    });
    if (!target) {
      return NextResponse.json({ accepted: true }, { status: 202 });
    }

    // l'appelant existe aussi (fromLabel = nickname public de l'annuaire)
    const caller = await db.user.findUnique({
      where: { pubkey: from },
      select: { nickname: true },
    });

    // FIRE-AND-FORGET (leçon C1 : le push ne bloque JAMAIS la requête)
    void sendPushToUser(to, {
      type: "incoming_call",
      fromLabel: caller?.nickname ?? "un contact",
    }).catch(() => {
      /* jamais bloquant */
    });

    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (e) {
    console.error("POST /api/call-knock", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
