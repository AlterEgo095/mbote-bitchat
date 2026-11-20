/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/posts/[id] — proxy détail d'un contenu public (back-office)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne (identique fiche utilisateur Étape 7) :
 *    navigateur ─cookie─▶ BFF ─verify─▶ app principale
 *    BFF ─x-admin-internal + x-admin-session + x-admin-actor─▶
 *    GET /api/internal/admin/posts/[id] (requireAdmin minRole support).
 *
 *  Le BFF ne décide rien : 404 (contenu purgé), 400 (id malformé) propagés ;
 *  502 backend-unreachable ≠ 401/403 (réponses du backend). Les MUTATIONS ne
 *  passent PAS ici : hide/unhide → /api/admin/moderation/action (proxy Étape
 *  6 existant), purge → four-eyes /api/pending-actions (proxy É9 existant).
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
    const r = await callBackend(`/api/internal/admin/posts/${encodeURIComponent(id)}`, {
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
