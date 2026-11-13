/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/break-glass — code de secours (ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Perte du téléphone TOTP : login email + CODE DE SECOURS (sans TOTP).
 *
 *   - 2 codes créés au bootstrap, hashés Argon2id, montrés une seule fois ;
 *   - un code VALIDÉ est BRÛLÉ (usedAt + ip + userAgent) — jamais réutilisable ;
 *   - TOUTES les sessions actives de l'admin sont révoquées ;
 *   - un NOUVEAU secret TOTP est généré immédiatement (totpEnrolled=false,
 *     ré-enrôlement forcé) et remis dans la réponse (réseau interne + HTTPS
 *     admin uniquement) — le prochain login exige le NOUVEAU TOTP ;
 *   - AdminAudit{action:'break-glass', actorId, ip, userAgent} (append-only) ;
 *   - notification aux AUTRES super-admins actifs : log serveur en attendant
 *     SMTP (NOT TESTÉ à documenter).
 *
 *  ARBITRAGE : la session émise par break-glass reste limitée aux surfaces
 *  de ré-enrôlement/lecture — le prochain login (avec le nouveau TOTP) est
 *  ce qui referme l'état d'urgence. TOUT échec (token interne OU email/code —
 *  camouflage total) → 401 { invalid credentials }, uniforme.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { verify as argon2Verify } from "@node-rs/argon2";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { executeBreakGlass } from "@/lib/mbote/admin-break-glass";
import { getSystemActor, writeAdminAudit } from "@/lib/mbote/admin-auth";
import { clientIp, internalTokenOk, loginRateCheck } from "@/lib/mbote/admin-internal";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ error: "invalid credentials" }, { status: 401 });

function normalizeCode(code: string): string {
  return (code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function POST(req: NextRequest) {
  const done = trackApiRequest("internal.admin.breakglass");
  try {
    if (!internalTokenOk(req)) return denied();

    const ip = clientIp(req);
    if (!loginRateCheck(ip)) {
      return NextResponse.json({ error: "too many attempts" }, { status: 429 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body?.code === "string" ? normalizeCode(body.code) : "";
    const userAgent = req.headers.get("user-agent");

    const user = email ? await db.adminUser.findUnique({ where: { email } }) : null;
    if (!user || user.disabledAt) {
      await auditFailure(email || "(vide)", ip, userAgent);
      return denied();
    }

    // vérification des codes NON BRÛLÉS (≤ 2 lignes — coût Argon2id borné)
    const candidates = await db.adminRecoveryCode.findMany({
      where: { adminUserId: user.id, usedAt: null },
      select: { id: true, codeHash: true },
    });
    let matchedId: number | null = null;
    for (const c of candidates) {
      if (await argon2Verify(c.codeHash, code).catch(() => false)) {
        matchedId = c.id;
        break;
      }
    }
    if (matchedId === null) {
      await auditFailure(email, ip, userAgent, user.id);
      return denied();
    }

    // ── usage valide : séquence ATOMIQUE (invariant §4d — burn→revoke→reset
    //    →session→audit en UNE $transaction ; tout crash = rollback complet,
    //    le code de secours reste utilisable et le TOTP actuel reste valide) ──
    const outcome = await executeBreakGlass({
      adminUserId: user.id,
      adminRole: user.role,
      recoveryCodeId: matchedId,
      ip,
      userAgent,
    });
    const { sessionsRevoked, newSecret, sessionToken, csrfToken, expiresAt } = outcome;

    // notification aux autres super-admins actifs — LOG (SMTP : NOT TESTÉ)
    const others = await db.adminUser.findMany({
      where: { role: "super-admin", disabledAt: null, id: { not: user.id } },
      select: { id: true, email: true },
    });
    if (others.length > 0) {
      console.warn(
        `[ADMIN-ALERT] break-glass utilisé par admin id=${user.id} (${user.email}) — ` +
          `à notifier : ${others.map((o) => `#${o.id} ${o.email}`).join(", ")} (fallback log — SMTP à venir)`
      );
    }

    const { buildOtpauthUri } = await import("@/lib/mbote/totp");
    return NextResponse.json({
      sessionToken,
      csrfToken,
      expiresAt: expiresAt.toISOString(),
      adminUser: { id: user.id, email: user.email, role: user.role, totpEnrolled: false },
      totpSecret: newSecret,
      otpauthUrl: buildOtpauthUri(user.email, newSecret),
      sessionsRevoked,
    });
  } catch (e) {
    console.error("POST /api/internal/admin/break-glass", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

async function auditFailure(email: string, ip: string, userAgent: string | null, userId?: number): Promise<void> {
  const system = await getSystemActor();
  await writeAdminAudit({
    actorId: userId ?? system.id,
    actorRole: userId ? (await db.adminUser.findUnique({ where: { id: userId }, select: { role: true } }))?.role ?? "system" : system.role,
    action: "login_failed",
    targetType: "AdminUser",
    targetId: email,
    after: { kind: "break-glass" },
    ip,
    userAgent,
  });
}
