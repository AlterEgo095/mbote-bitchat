/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/queue — proxy file de modération CURSOR (ADM Étape 6)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique au dashboard Étape 5) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶ /api/internal/admin/queue
 *  L'app principale impose requireAdmin({minRole:"support"}) (arbitrage
 *  §12.17 : auditor STRICT → 403 propagé à l'identique) + cursor/filtres.
 *
 *  DÉGRADATION (directive Étape 6 : « gestion 502 distinct de 401 » — même
 *  sémantique que /api/dashboard Étape 5) :
 *   - backend INJOIGNABLE (fetch lève — au verify OU à l'appel) → 502
 *     { error: "backend-unreachable" } — JAMAIS de 500 brut ;
 *   - session absente/invalide (backend a RÉPONDU 401) → 401 uniforme ;
 *   - rôle insuffisant (backend a RÉPONDU 403) → 403 uniforme ;
 *   - curseur malformé (backend a RÉPONDU 400) → propagé tel quel.
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function GET(req: NextRequest) {
  // 1. verify : une ERREUR RÉSEAU (backend mort) n'est PAS une session invalide
  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  // 2. queue : même distinction (le backend peut tomber ENTRE verify et l'appel)
  try {
    const qs = req.nextUrl.search; // cursor, period, type, status — forward brut
    const r = await callBackend(`/api/internal/admin/queue${qs}`, {
      method: "GET",
      sessionToken: sessionTokenFrom(req),
      actorId: session.adminUserId,
      clientForwardedFor: req.headers.get("x-forwarded-for"),
    });
    if (r.status === 401 || r.status === 403) return denied(r.status);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    return unreachable();
  }
}
