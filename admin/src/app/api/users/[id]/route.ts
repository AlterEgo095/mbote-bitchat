/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/users/[id] — proxy fiche utilisateur (ADM Étape 7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  [id] = pubkey (identité publique opératoire — arbitrage §13.2). 404
 *  utilisateur inconnu PROPAGÉ tel quel (validation métier du backend) ;
 *  502 réseau ≠ 401/403 (réponses du backend).
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  const { id } = await params;
  if (!id || id.length === 0 || id.length > 200) {
    return NextResponse.json({ error: "id invalide" }, { status: 400 });
  }

  try {
    const r = await callBackend(
      `/api/internal/admin/users/${encodeURIComponent(id)}`,
      {
        method: "GET",
        sessionToken: sessionTokenFrom(req),
        actorId: session.adminUserId,
        clientForwardedFor: req.headers.get("x-forwarded-for"),
      }
    );
    if (r.status === 401 || r.status === 403) return denied(r.status);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    return unreachable();
  }
}
