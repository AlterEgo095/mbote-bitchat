/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/network — proxy vue RÉSEAU SOCIAL (suivis, crédits — read-only)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique annuaire posts) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/network (requireAdmin minRole support).
 *
 *  READ-ONLY strict : AUCUNE mutation ne passe ici (pas de POST) — graphe de
 *  suivis (comptes, paires mutuelles, top suivis) et soldes de crédits en
 *  métadonnées seulement. Pas de query : 502 backend-unreachable ≠ 401/403
 *  (réponses du backend propagées à l'identique).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  callBackend,
  denied,
  sessionTokenFrom,
  verifyPanelSession,
  type PanelSession,
} from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function GET(req: NextRequest) {
  let session: PanelSession | null = null;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  try {
    const r = await callBackend("/api/internal/admin/network", {
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
