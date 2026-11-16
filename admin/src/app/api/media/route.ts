/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/media — proxy annuaire des OBJETS MÉDIA (back-office 2026-11)
 *  POST /api/media — proxy purges média (purge_media / purge_pending_expired)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique annuaire posts) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/media (requireAdmin minRole support — auditor
 *    STRICT → 403 propagé à l'identique).
 *
 *  GET — query forwardée BRUTE (status, period, owner, cursor) : le BFF ne
 *  décide rien, 400/422 (filtres invalides) sont des validations métier
 *  PROPAGÉES. NB : les objets média sont CHIFFRÉS E2EE côté client — le
 *  backend n'expose que des métadonnées (tailles, statut, propriétaire),
 *  jamais un contenu déchiffrable (invariant §1.4).
 *
 *  POST — RBAC moderator minimum CÔTÉ APP PRINCIPALE (le BFF n'impose pas le
 *  rôle, il exige seulement la PRÉSENCE du CSRF — la valeur est validée
 *  timing-safe par l'app principale). 400/404/422 (justification §6 < 20
 *  caractères, id inconnu, maxAgeHours hors 1..720) propagés à l'identique ;
 *  502 backend-unreachable ≠ 401/403 (réponses du backend).
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
    const qs = req.nextUrl.search; // status, period, owner, cursor — brut
    const r = await callBackend(`/api/internal/admin/media${qs}`, {
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

export async function POST(req: NextRequest) {
  let session: PanelSession | null = null;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  const csrf = req.headers.get("x-admin-csrf");
  if (!csrf) return denied(403); // mutation sans CSRF : même message uniforme

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corps JSON illisible" }, { status: 400 });
  }

  try {
    const r = await callBackend("/api/internal/admin/media", {
      method: "POST",
      sessionToken: sessionTokenFrom(req),
      actorId: session.adminUserId,
      csrf,
      clientForwardedFor: req.headers.get("x-forwarded-for"),
      body,
    });
    if (r.status === 401 || r.status === 403) return denied(r.status);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    return unreachable();
  }
}
