/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/admin/moderation/queue — proxy file de modération (ADM Étape 4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  PREMIER chemin proxyfié complet (preuve de la chaîne Étape 4) :
 *    navigateur ─cookie+CSRF─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶ /api/moderation/queue
 *  L'app principale applique requireAdmin (session + token interne + acteur +
 *  rôle ≥ auditor — matrice RBAC §4). Aucun secret en réponse.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await verifyPanelSession(req);
  if (!session) return denied(401);

  const params = new URLSearchParams(req.nextUrl.search);
  const qs = params.toString();
  const r = await callBackend(`/api/moderation/queue${qs ? `?${qs}` : ""}`, {
    method: "GET",
    sessionToken: sessionTokenFrom(req),
    actorId: session.adminUserId,
    clientForwardedFor: req.headers.get("x-forwarded-for"),
  });

  if (r.status === 401 || r.status === 403) return denied(r.status);
  return NextResponse.json(r.body, { status: r.status });
}
