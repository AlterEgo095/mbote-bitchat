/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/logout — révocation de session (ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Révoque la session courante (revokedAt + revokedReason='logout'), écrit
 *  AdminAudit{logout}, répond ok. Idempotent : session déjà morte → ok.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { getSessionFromToken, revokeAdminSession, writeAdminAudit } from "@/lib/mbote/admin-auth";
import {
  CSRF_HEADER,
  SESSION_TOKEN_HEADER,
  clientIp,
  internalTokenOk,
  safeEqual,
} from "@/lib/mbote/admin-internal";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

export async function POST(req: NextRequest) {
  const done = trackApiRequest("internal.admin.logout");
  try {
    if (!internalTokenOk(req)) return denied();
    const token = req.headers.get(SESSION_TOKEN_HEADER) ?? req.cookies.get("mbote_admin_session")?.value;
    const ctx = await getSessionFromToken(token);

    if (ctx) {
      // mutation authentifiée → CSRF obligatoire (message uniforme 403)
      const csrf = req.headers.get(CSRF_HEADER);
      if (!csrf || !safeEqual(csrf, ctx.csrfToken)) {
        return NextResponse.json({ error: "unauthorized" }, { status: 403 });
      }
      await revokeAdminSession(ctx.sessionId, "logout");
      await writeAdminAudit({
        actorId: ctx.adminUserId,
        actorRole: ctx.role,
        action: "logout",
        targetType: "AdminSession",
        targetId: ctx.sessionId,
        ip: clientIp(req),
        userAgent: req.headers.get("user-agent"),
      });
    }
    // idempotent — session inconnue → ok quand même (le cookie sera effacé)
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("POST /api/internal/admin/logout", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
