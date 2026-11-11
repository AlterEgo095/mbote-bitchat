import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifySignedMessage } from "@/lib/mbote/proof";
import { getRateStore, trackApiRequest } from "@/lib/mbote/state-store";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/push/unsubscribe — désabonnement signé (C1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  AUTH = preuve de possession sur `${me}|push-unsub|${endpoint}|${ts}`.
 *  Directive : « Supprime l'abonnement (disabledAt) » → PURGE DOUCE : la
 *  ligne reste (disabledAt posé) — cohérent avec la purge 410 du sender et
 *  utile au diagnostic. Idempotent (déjà désactivé → 200 tel quel).
 * ─────────────────────────────────────────────────────────────────────────────
 */

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  const done = trackApiRequest("push.unsubscribe");
  try {
    const body = (await req.json().catch(() => null)) as
      | { me?: unknown; endpoint?: unknown; ts?: unknown; signature?: unknown }
      | null;
    if (!body) return bad(400, "corps illisible (JSON attendu)");
    const me = typeof body.me === "string" ? body.me : "";
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!me || !endpoint) return bad(400, "me et endpoint requis");

    const check = await verifySignedMessage({
      message: `${me}|push-unsub|${endpoint}|${body.ts as number}`,
      pubkey: me,
      ts: body.ts,
      signature: body.signature,
    });
    if (!check.valid) {
      return bad(401, `Preuve de possession refusée : ${check.reason ?? "invalide"}`);
    }

    // rate limit léger (abus d'écriture)
    const rates = getRateStore();
    if (!rates.hit(`push-unsub:${me}`, 30, 3600_000).allowed) {
      return bad(429, "Trop de désabonnements — ralentissez");
    }

    const result = await db.pushSubscription.updateMany({
      where: { endpoint, userId: me, disabledAt: null },
      data: { disabledAt: new Date() },
    });
    // updateMany sur une ligne d'AUTRUI → 0 modifié : 404 (pas de fuite)
    if (result.count === 0) {
      const exists = await db.pushSubscription.findUnique({
        where: { endpoint },
        select: { userId: true, disabledAt: true },
      });
      if (!exists) return bad(404, "Abonnement inconnu");
      if (exists.userId !== me) return bad(404, "Abonnement inconnu"); // anti-énumération
      return NextResponse.json({ subscription: { endpoint, active: false, alreadyDisabled: true } });
    }

    return NextResponse.json({ subscription: { endpoint, active: false } });
  } catch (e) {
    console.error("POST /api/push/unsubscribe", e);
    return bad(500, "Erreur serveur");
  } finally {
    done();
  }
}
