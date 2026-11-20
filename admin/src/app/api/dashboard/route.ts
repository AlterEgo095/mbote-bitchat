/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/dashboard — BFF proxy vers /api/internal/admin/stats (Étape 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Même chaîne que le proxy queue (Étape 4) : navigateur ─cookie─▶ BFF
 *  ─verify─▶ app principale, puis BFF ─x-admin-internal + x-admin-session +
 *  x-admin-actor─▶ /api/internal/admin/stats (rôle ≥ support imposé PAR
 *  L'APP PRINCIPALE — l'auditor reçoit 403 propagé à l'identique).
 *
 *  DÉGRADATION (directive Étape 5 : « kill backend → dashboard affiche
 *  backend injoignable au lieu de crasher ») : distingue
 *   - backend INJOIGNABLE (fetch lève — au verify OU à l'appel stats)
 *       → 502 { error: "backend-unreachable" } — JAMAIS de 500 brut ;
 *   - session absente/invalide (le backend a RÉPONDU 401) → 401 uniforme ;
 *   - rôle insuffisant (le backend a RÉPONDU 403) → 403 uniforme.
 *  L'UI traduit 502 en bandeau « backend injoignable » (DashboardMetrics).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";
import { clientIp } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function GET(req: NextRequest) {
  // 1. verify : une ERREUR RÉSEAU (backend mort) n'est PAS une session
  //    invalide — 502, pas 401 (sinon l'UI afficherait « session expirée »
  //    pendant une panne : mensonge dangereux pour un outil de pilotage).
  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  // 2. stats : même distinction (le backend peut tomber ENTRE verify et stats)
  try {
    const r = await callBackend("/api/internal/admin/stats", {
      method: "GET",
      sessionToken: sessionTokenFrom(req),
      actorId: session.adminUserId,
      clientForwardedFor: clientIp(req.headers),
    });

    if (r.status === 401 || r.status === 403) return denied(r.status);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    return unreachable();
  }
}
