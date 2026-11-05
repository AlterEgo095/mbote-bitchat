/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/admin/auth/logout — déconnexion (BFF, ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Révoque la session côté app principale (audit logout) puis efface le
 *  cookie. Idempotent : session inconnue/expirée → { ok:true } + cookie
 *  effacé quand même. CSRF exigé quand la session est valide (mutation).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  callBackend,
  cookieFlags,
  denied,
  sessionTokenFrom,
  verifyPanelSession,
} from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = sessionTokenFrom(req);
  const session = await verifyPanelSession(req);
  if (session) {
    // mutation authentifiée → CSRF obligatoire (message uniforme)
    const csrf = req.headers.get("x-admin-csrf");
    if (!csrf || csrf !== session.csrfToken) return denied(403);
  }

  await callBackend("/api/internal/admin/logout", {
    sessionToken: token,
    csrf: req.headers.get("x-admin-csrf"),
    actorId: session?.adminUserId ?? null,
    clientForwardedFor: req.headers.get("x-forwarded-for"),
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { ...cookieFlags(), maxAge: 0 });
  return res;
}
