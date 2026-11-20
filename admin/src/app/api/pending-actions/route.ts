/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  /api/pending-actions — proxy FOUR-EYES (ADM Étape 9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET  — liste des intentions (page /pending-actions) : CSRF non exigé
 *         (lecture), rôle vérifié PAR LE BACKEND (moderator min).
 *  POST — créer une intention (ban_user | purge_post) : CSRF exigé ici, rôle
 *         super-admin validé par le backend. Le BFF ne décide rien : 400/409/
 *         410/422 propagés tels quels (l'UI les affiche), 401/403 unifiés
 *         `unauthorized` (jamais de fuite de raison RBAC).
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
    const qs = req.nextUrl.search;
    const r = await callBackend(`/api/internal/admin/pending-actions${qs}`, {
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
  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  const csrf = req.headers.get("x-admin-csrf");
  if (!csrf) return denied(403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corps JSON illisible" }, { status: 400 });
  }

  try {
    const r = await callBackend("/api/internal/admin/pending-actions", {
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
