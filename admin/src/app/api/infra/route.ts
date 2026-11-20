/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/infra — proxy vue INFRASTRUCTURE (passerelles mesh, push)
 *  POST /api/infra — proxy purge des abonnements push désactivés
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique annuaire posts) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/infra (requireAdmin minRole support).
 *
 *  GET — read-only : état des passerelles mesh (paquets in/out, lastSeen) et
 *  des abonnements push (actifs / désactivés). Endpoints push TRONQUÉS par le
 *  backend (pas d'URL complète : token d'abonnement absent par conception).
 *
 *  POST — RBAC moderator minimum CÔTÉ APP PRINCIPALE (le BFF exige seulement
 *  la PRÉSENCE du CSRF — valeur validée timing-safe par l'app principale).
 *  { action:"purge_disabled_push_subs", maxAgeDays?(1..365, défaut 30),
 *  justification } ; 400/422 (justification §6 < 20 caractères, maxAgeDays
 *  invalide) propagés à l'identique ; 502 backend-unreachable ≠ 401/403.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  callBackend,
  denied,
  sessionTokenFrom,
  verifyPanelSession,
  type PanelSession,
} from "@/lib/admin-backend";
import { clientIp } from "@/lib/client-ip";

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
    const r = await callBackend("/api/internal/admin/infra", {
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
    const r = await callBackend("/api/internal/admin/infra", {
      method: "POST",
      sessionToken: sessionTokenFrom(req),
      actorId: session.adminUserId,
      csrf,
      clientForwardedFor: clientIp(req.headers),
      body,
    });
    if (r.status === 401 || r.status === 403) return denied(r.status);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    return unreachable();
  }
}
