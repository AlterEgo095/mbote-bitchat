/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/admin/auth/totp-enroll — ré-enrôlement TOTP (BFF, ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Après break-glass : valide le NOUVEAU secret avec un premier code TOTP.
 *  Session requise + CSRF (mutation) — délégué à l'app principale.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { callBackend, denied, sessionTokenFrom, verifyPanelSession } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await verifyPanelSession(req);
  if (!session) return denied(401);
  const csrf = req.headers.get("x-admin-csrf");
  if (!csrf || csrf !== session.csrfToken) return denied(403);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await callBackend("/api/internal/admin/totp-enroll", {
    body: { code: typeof body?.code === "string" ? body.code : "" },
    sessionToken: sessionTokenFrom(req),
    csrf,
    actorId: session.adminUserId,
    clientForwardedFor: req.headers.get("x-forwarded-for"),
  });

  if (r.status !== 200) return denied(401);
  return NextResponse.json({ ok: true, totpEnrolled: true });
}
