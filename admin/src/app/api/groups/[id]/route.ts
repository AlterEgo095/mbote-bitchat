/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/groups/[id] — proxy fiche d'un groupe MLS (MÉTADONNÉES ONLY,
 *  back-office 2026-11)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique fiche post) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/groups/[id] (requireAdmin minRole support).
 *
 *  INVARIANT E2EE (ADMIN-RBAC §1.4) : la fiche expose le shell du groupe
 *  (nom, mlsGroupId, créateur), l'annuaire des MEMBRES (join/leave) et les
 *  MÉTADONNÉES des 50 derniers messages / 20 dernières enveloppes MLS
 *  (expéditeur, epoch, taille LENGTH(payload)) — AUCUN ciphertext.
 *
 *  Le BFF ne décide rien : 404 (groupe absent) et 400 (id malformé) propagés ;
 *  502 backend-unreachable ≠ 401/403 (réponses du backend). Les MUTATIONS ne
 *  passent PAS ici : purge des contenus chiffrés → four-eyes
 *  /api/pending-actions (proxy existant, actionType purge_group_messages).
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";
import { clientIp } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  try {
    const r = await callBackend(`/api/internal/admin/groups/${encodeURIComponent(id)}`, {
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
