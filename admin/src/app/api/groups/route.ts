/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/groups — proxy annuaire des groupes MLS (MÉTADONNÉES ONLY,
 *  back-office 2026-11)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique annuaire posts) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/groups (requireAdmin minRole support — arbitrage
 *    §13.1 : auditor STRICT → 403 propagé à l'identique).
 *
 *  INVARIANT E2EE (ADMIN-RBAC §1.4) : les messages de groupe sont chiffrés MLS
 *  — cette route ne renvoie que des métadonnées (nom, mlsGroupId, créateur,
 *  compteurs membres/messages/enveloppes, timestamps). Le BFF ne déchiffre
 *  rien et ne voit jamais le contenu d'un message de groupe.
 *
 *  Query forwardée BRUTE (period, q, cursor) — le BFF ne décide rien : 400
 *  (cursor malformé) est une validation métier PROPAGÉE ; 502
 *  backend-unreachable ≠ 401/403 (réponses du backend).
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
    const qs = req.nextUrl.search; // period, q, cursor — brut
    const r = await callBackend(`/api/internal/admin/groups${qs}`, {
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
