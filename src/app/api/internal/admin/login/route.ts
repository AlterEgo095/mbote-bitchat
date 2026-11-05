/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/login — vérification credentials (ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Appelé par le panneau admin (BFF) via le réseau interne, gardé par le
 *  token interne (RBAC §8). UN SEUL round-trip : email + password + TOTP.
 *
 *   - rate-limit 5 tentatives / 5 min / IP → 429 { too many attempts } ;
 *   - TOUT échec → 401 { unauthorized } — uniforme, aucune cause révélée ;
 *   - succès → AdminAudit{login_success} (+ {totp_enrolled} au premier login)
 *     + session créée (token 32 octets, hash seul en DB) ;
 *   - la réponse (réseau Docker interne uniquement) porte le token de session
 *     brut : c'est LE point de remise au BFF, qui le pose en cookie sur le
 *     domaine admin (HttpOnly, SameSite=Strict, Secure en prod).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { createAdminSession, getSystemActor, writeAdminAudit } from "@/lib/mbote/admin-auth";
import { clientIp, internalTokenOk, loginRateCheck } from "@/lib/mbote/admin-internal";
import { verifyAdminLogin } from "@/lib/mbote/admin-login";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ error: "invalid credentials" }, { status: 401 });

export async function POST(req: NextRequest) {
  const done = trackApiRequest("internal.admin.login");
  try {
    if (!internalTokenOk(req)) return denied();

    const ip = clientIp(req);
    if (!loginRateCheck(ip)) {
      return NextResponse.json({ error: "too many attempts" }, { status: 429 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const totpCode =
      typeof body?.totp === "string" ? body.totp : typeof body?.totpCode === "string" ? body.totpCode : "";
    const userAgent = req.headers.get("user-agent");

    const outcome = await verifyAdminLogin(db, { email, password, totpCode });
    if (!outcome.ok) {
      // audit d'échec : actorId = pseudo-user system, cible = email soumis
      // (identique pour email inconnu — aucune énumération de comptes)
      const system = await getSystemActor();
      await writeAdminAudit({
        actorId: system.id,
        actorRole: system.role,
        action: "login_failed",
        targetType: "AdminUser",
        targetId: email.trim().toLowerCase() || "(vide)",
        after: { kind: "login" },
        ip,
        userAgent,
      });
      return denied();
    }

    const { user, totpJustEnrolled } = outcome;
    const session = await createAdminSession(user.id, { ip, userAgent });
    await writeAdminAudit({
      actorId: user.id,
      actorRole: user.role,
      action: "login_success",
      targetType: "AdminUser",
      targetId: String(user.id),
      after: { totpJustEnrolled },
      ip,
      userAgent,
    });
    if (totpJustEnrolled) {
      await writeAdminAudit({
        actorId: user.id,
        actorRole: user.role,
        action: "totp_enrolled",
        targetType: "AdminUser",
        targetId: String(user.id),
        after: { enrolledAt: new Date().toISOString() },
        ip,
        userAgent,
      });
    }

    return NextResponse.json({
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
      adminUser: { id: user.id, email: user.email, role: user.role, totpEnrolled: true },
    });
  } catch (e) {
    console.error("POST /api/internal/admin/login", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
