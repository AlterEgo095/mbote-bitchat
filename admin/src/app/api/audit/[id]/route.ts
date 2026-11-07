/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/audit/[id] — proxy DÉTAIL d'une ligne d'audit (ADM Étape 8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Chaîne identique à la liste (/api/audit) — l'id est validé PAR L'APP
 *  PRINCIPALE (400 non entier, 404 inconnu, propagés). LECTURE SEULE.
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

const unreachable = () =>
  NextResponse.json({ error: "backend-unreachable" }, { status: 502 });

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  let session;
  try {
    session = await verifyPanelSession(req);
  } catch {
    return unreachable();
  }
  if (!session) return denied(401);

  const { id } = await ctx.params;
  try {
    const r = await callBackend(`/api/internal/admin/audit/${encodeURIComponent(id)}`, {
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
