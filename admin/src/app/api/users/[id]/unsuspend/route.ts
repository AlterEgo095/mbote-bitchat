/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/users/[id]/unsuspend — proxy MUTATION levée de suspension (E7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Arbitrage §13.5 (levée nécessaire à l'exploitation) — même chaîne que
 *  warn/suspend : CSRF ici, rôle + justification §6 imposés par le backend.
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
    const r = await callBackend(`/api/internal/admin/users/${encodeURIComponent(id)}/unsuspend`, {
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
