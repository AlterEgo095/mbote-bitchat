/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/audit — proxy journal d'audit CURSOR (ADM Étape 8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique queue É6 / users É7) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/audit (exactRoles auditor + super-admin —
 *    arbitrage §14.1 ; support/moderator → 403 PROPAGÉ à l'identique).
 *
 *  DÉGRADATION (pattern É5/É6/É7) : backend INJOIGNABLE → 502
 *  { error: "backend-unreachable" } — JAMAIS de 500 brut ; session absente →
 *  401 ; rôle insuffisant → 403 ; validations métier (400 cursor malformé,
 *  422 export trop volumineux) PROPAGÉES tel quel.
 *
 *  LECTURE SEULE : ce BFF n'expose AUCUNE mutation d'audit (invariant §1.3 —
 *  append-only n'a pas de contre-écriture).
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
    const qs = req.nextUrl.search; // actor, action, targetType, since, from, to, target, cursor — brut
    const r = await callBackend(`/api/internal/admin/audit${qs}`, {
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
