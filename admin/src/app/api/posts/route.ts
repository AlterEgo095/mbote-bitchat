/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/posts — proxy annuaire GLOBAL des contenus publics (back-office)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique users Étape 7 / queue Étape 6) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/posts (requireAdmin minRole support — arbitrage
 *    §13.1 : auditor STRICT → 403 propagé à l'identique).
 *
 *  Query forwardée BRUTE (q, cursor, status, kind, period, author) — le BFF
 *  ne décide rien : 400 (q vide / cursor malformé) et 404 sont des validations
 *  métier PROPAGÉES ; 502 backend-unreachable ≠ 401/403 (réponses du backend).
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
    const qs = req.nextUrl.search; // q, cursor, status, kind, period, author — brut
    const r = await callBackend(`/api/internal/admin/posts${qs}`, {
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
