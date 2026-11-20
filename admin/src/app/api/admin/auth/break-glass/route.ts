/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/admin/auth/break-glass — code de secours (BFF, ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Perte du téléphone TOTP : email + code de secours (SANS TOTP). Le code est
 *  brûlé côté app principale, toutes les sessions de l'admin sont révoquées,
 *  un NOUVEAU secret TOTP est émis (ré-enrôlement forcé).
 *
 *  La réponse porte le nouveau secret + URI otpauth (ré-enrôlement immédiat) :
 *  c'est la SEULE réponse de ce panneau contenant un secret, par conception —
 *  elle transite sur HTTPS (domaine admin) vers l'admin détenteur du code.
 *  Échec → 401 uniforme · 429 si rate-limit. Cookie posé (état d'urgence).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, callBackend, cookieFlags, denied } from "@/lib/admin-backend";
import { clientIp } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await callBackend("/api/internal/admin/break-glass", {
    body: {
      email: typeof body?.email === "string" ? body.email : "",
      code: typeof body?.code === "string" ? body.code : "",
    },
    clientForwardedFor: clientIp(req.headers),
  });

  if (r.status !== 200) {
    const status = r.status === 429 ? 429 : 401;
    return NextResponse.json(
      { error: r.status === 429 ? "too many attempts" : "invalid credentials" },
      { status }
    );
  }

  const sessionToken = typeof r.body.sessionToken === "string" ? r.body.sessionToken : "";
  const csrfToken = typeof r.body.csrfToken === "string" ? r.body.csrfToken : "";
  if (!sessionToken || !csrfToken) return denied(401);

  const adminUser = (r.body.adminUser ?? {}) as Record<string, unknown>;
  const res = NextResponse.json({
    csrfToken,
    email: adminUser.email,
    role: adminUser.role,
    totpEnrolled: false,
    // ré-enrôlement immédiat — nouveau secret montré UNE fois :
    totpSecret: r.body.totpSecret,
    otpauthUrl: r.body.otpauthUrl,
    sessionsRevoked: r.body.sessionsRevoked,
  });
  res.cookies.set(ADMIN_COOKIE, sessionToken, cookieFlags());
  return res;
}
