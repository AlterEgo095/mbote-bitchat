/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/users/[id]/warn — proxy MUTATION warn (ADM Étape 7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Identique à /api/admin/moderation/action (Étape 6) : CSRF exigé à l'entrée
 *  du BFF (présence — la valeur est validée TIMING-SAFE par l'app principale
 *  contre la session), 502 réseau ≠ 401/403 ≠ 400/404/422 propagés.
 *  Rôle moderator imposé PAR LE BACKEND (arbitrage §13.1) — le BFF ne décide
 *  rien.
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function POST(
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

  const csrf = req.headers.get("x-admin-csrf");
  if (!csrf) return denied(403);

  const { id } = await params;
  if (!id || id.length === 0 || id.length > 200) {
    return NextResponse.json({ error: "id invalide" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corps JSON illisible" }, { status: 400 });
  }

  try {
    const r = await callBackend(`/api/internal/admin/users/${encodeURIComponent(id)}/warn`, {
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
