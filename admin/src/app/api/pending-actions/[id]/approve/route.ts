/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/pending-actions/[id]/approve — proxy MUTATION four-eyes (É9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Approbation par un second admin distinct → le backend exécute la vraie
 *  action (ban | purge) dans une transaction auditée. CSRF exigé ici, gardes
 *  (auto-approbation 403, expiration 410, déjà traitée 409) validées PAR LE
 *  BACKEND et propagées — le BFF ne décide rien.
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
  if (!id || !/^\d+$/.test(id) || id.length > 12) {
    return NextResponse.json({ error: "id invalide" }, { status: 400 });
  }

  try {
    const r = await callBackend(`/api/internal/admin/pending-actions/${id}/approve`, {
      method: "POST",
      sessionToken: sessionTokenFrom(req),
      actorId: session.adminUserId,
      csrf,
      clientForwardedFor: req.headers.get("x-forwarded-for"),
      body: {},
    });
    if (r.status === 401 || r.status === 403) return denied(r.status);
    return NextResponse.json(r.body, { status: r.status });
  } catch {
    return unreachable();
  }
}
