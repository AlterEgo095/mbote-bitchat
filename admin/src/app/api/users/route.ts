/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/users — proxy annuaire utilisateurs (ADM Étape 7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique queue Étape 6 / dashboard Étape 5) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/users (requireAdmin minRole support — arbitrage
 *    §13.1 : auditor STRICT → 403 propagé à l'identique).
 *
 *  Query forwardée BRUTE (q, cursor, sort, status, period) — le BFF ne décide
 *  rien : 400 (q vide / cursor malformé) et 404 sont des validations métier
 *  PROPAGÉES ; 502 backend-unreachable ≠ 401/403 (réponses du backend).
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  try {
    const qs = req.nextUrl.search; // q, cursor, sort, status, period — brut
    const r = await callBackend(`/api/internal/admin/users${qs}`, {
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
