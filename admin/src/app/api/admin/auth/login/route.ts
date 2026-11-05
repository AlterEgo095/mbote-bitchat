/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/admin/auth/login — login panneau (BFF sans état, ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  3 champs (email + password + TOTP), un seul round-trip. Le BFF délègue la
 *  vérification à l'app principale (Argon2id + TOTP + rate-limit y vivent),
 *  puis pose le cookie `mbote_admin_session` sur le DOMAINE ADMIN :
 *  HttpOnly · SameSite=Strict · Path=/ · Secure en prod.
 *
 *  Le corps de réponse ne contient JAMAIS le token de session (il ne vit que
 *  dans le cookie) — il porte { csrfToken } (directive Étape 3) + état de
 *  compte non sensible. Échec → 401 uniforme relayé · 429 si rate-limit.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, callBackend, cookieFlags, denied } from "@/lib/admin-backend";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await callBackend("/api/internal/admin/login", {
    body: {
      email: typeof body?.email === "string" ? body.email : "",
      password: typeof body?.password === "string" ? body.password : "",
      totp: typeof body?.totp === "string" ? body.totp : "",
    },
    clientForwardedFor: req.headers.get("x-forwarded-for"),
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
    totpEnrolled: adminUser.totpEnrolled === true,
    expiresAt: r.body.expiresAt,
  });
  res.cookies.set(ADMIN_COOKIE, sessionToken, cookieFlags());
  return res;
}
