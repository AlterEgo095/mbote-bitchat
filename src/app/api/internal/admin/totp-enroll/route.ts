/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/totp-enroll — ré-enrôlement TOTP (ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Après un break-glass : la session émise valide le NOUVEAU secret avec un
 *  premier code TOTP valide → totpEnrolled=true + AdminAudit{totp_enrolled}.
 *  Session requise (x-admin-session) + token interne. Échec → 401 uniforme.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { getSessionFromToken, writeAdminAudit } from "@/lib/mbote/admin-auth";
import { withWriteLock } from "@/lib/mbote/write-mutex";
import {
  CSRF_HEADER,
  SESSION_TOKEN_HEADER,
  clientIp,
  internalTokenOk,
  safeEqual,
} from "@/lib/mbote/admin-internal";
import { verifyTotp } from "@/lib/mbote/totp";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

export async function POST(req: NextRequest) {
  const done = trackApiRequest("internal.admin.totpenroll");
  try {
    if (!internalTokenOk(req)) return denied();
    const token = req.headers.get(SESSION_TOKEN_HEADER) ?? req.cookies.get("mbote_admin_session")?.value;
    const ctx = await getSessionFromToken(token);
    if (!ctx) return denied();

    // mutation authentifiée → CSRF obligatoire (message uniforme 403)
    const csrf = req.headers.get(CSRF_HEADER);
    if (!csrf || !safeEqual(csrf, ctx.csrfToken)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const code = typeof body?.code === "string" ? body.code : "";

    const user = await db.adminUser.findUnique({ where: { id: ctx.adminUserId } });
    if (!user || user.disabledAt || !user.totpSecret) return denied();

    const t = verifyTotp(user.totpSecret, code, { lastCounter: user.totpLastCounter ?? null });
    if (!t.ok || t.counter === null) return denied();

    // ATOMIQUE (invariant §4d, écart corrigé vague durcissement) : enrollment
    // + audit dans la même $transaction — un crash entre les deux ne laisse
    // pas un enrollment SANS trace d'audit (append-only). Section admin
    // multi-écritures → withWriteLock (règle 2 §4d).
    await withWriteLock(() =>
      db.$transaction(async (tx) => {
        await tx.adminUser.update({
          where: { id: user.id },
          data: { totpEnrolled: true, totpLastCounter: t.counter },
        });
        await writeAdminAudit({
          tx,
          actorId: user.id,
          actorRole: user.role,
          action: "totp_enrolled",
          targetType: "AdminUser",
          targetId: String(user.id),
          after: { via: "break-glass re-enrollment" },
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent"),
        });
      })
    );

    return NextResponse.json({ ok: true, totpEnrolled: true });
  } catch (e) {
    console.error("POST /api/internal/admin/totp-enroll", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
