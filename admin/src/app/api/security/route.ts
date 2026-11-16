/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/security — proxy vue SÉCURITÉ (read-only, back-office 2026-11)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique annuaire posts) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/security (requireAdmin minRole support).
 *
 *  READ-ONLY strict : AUCUNE mutation ne passe ici (pas de POST) — les
 *  données servies sont des MÉTADONNÉES de défense (clés vérifiées, blocs
 *  pairs, gardes anti-rejeu, ingestion mesh, PoW). Aucun contenu privé ni
 *  payload chiffré ne traverse ce proxy (invariant §1.4) — un DM rejoué dans
 *  les tables n'apparaît que comme compteur/garde, jamais comme texte.
 *
 *  Pas de query : 502 backend-unreachable ≠ 401/403 (réponses du backend
 *  propagées à l'identique).
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
    const r = await callBackend("/api/internal/admin/security", {
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
