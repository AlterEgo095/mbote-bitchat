/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/verify — validation de session (ADM Étapes 3+4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  « Appel de vérification depuis le panneau » (directive Étape 4) : le BFF
 *  admin valide CHAQUE requête authentifiée ici avant de proxyfier. Le token
 *  de session transite par le header `x-admin-session` (réseau Docker interne),
 *  sa résolution passe par getSessionFromToken (hash en DB, idle 30 min,
 *  absolu 8 h, révocation, admin désactivé) — lastSeenAt est mis à jour.
 *
 *   - token interne requis → 401 uniforme ;
 *   - session invalide → 401 uniforme ;
 *   - succès → { adminUserId, role, csrfToken, email, totpEnrolled }.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { getSessionFromToken } from "@/lib/mbote/admin-auth";
import { SESSION_TOKEN_HEADER, internalTokenOk } from "@/lib/mbote/admin-internal";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

export async function POST(req: NextRequest) {
  const done = trackApiRequest("internal.admin.verify");
  try {
    if (!internalTokenOk(req)) return denied();
    const token = req.headers.get(SESSION_TOKEN_HEADER) ?? req.cookies.get("mbote_admin_session")?.value;
    const ctx = await getSessionFromToken(token);
    if (!ctx) return denied();

    const totpEnrolled = await db.adminUser
      .findUnique({ where: { id: ctx.adminUserId }, select: { totpEnrolled: true } })
      .then((u) => u?.totpEnrolled ?? false);

    return NextResponse.json({
      adminUserId: ctx.adminUserId,
      role: ctx.role,
      email: ctx.email,
      csrfToken: ctx.csrfToken,
      sessionId: ctx.sessionId,
      totpEnrolled,
    });
  } catch (e) {
    console.error("POST /api/internal/admin/verify", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
