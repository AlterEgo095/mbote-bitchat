/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/dms — proxy annuaire des paires DM (MÉTADONNÉES ONLY, back-office
 *  2026-11)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique annuaire posts) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/dms (requireAdmin minRole support — arbitrage
 *    §13.1 : auditor STRICT → 403 propagé à l'identique).
 *
 *  INVARIANT E2EE (ADMIN-RBAC §1.4) : cette route ne transporte AUCUN contenu
 *  — uniquement des métadonnées agrégées par paire (compteurs, octets de
 *  ciphertext, timestamps). Le BFF ne déchiffre rien (il n'a pas la clé) et ne
 *  touche jamais au ciphertext.
 *
 *  Query forwardée BRUTE (status, period, q, cursor) — le BFF ne décide rien :
 *  400 (q < 3 caractères / cursor malformé) est une validation métier PROPAGÉE
 *  ; 502 backend-unreachable ≠ 401/403 (réponses du backend).
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";
import { clientIp } from "@/lib/client-ip";

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
    const qs = req.nextUrl.search; // status, period, q, cursor — brut
    const r = await callBackend(`/api/internal/admin/dms${qs}`, {
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
