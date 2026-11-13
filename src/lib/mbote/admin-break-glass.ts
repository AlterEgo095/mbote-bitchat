/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  break-glass — séquence d'usage ATOMIQUE (invariant §4d DEV-SETUP)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Extrait du route handler (vague durcissement — écart majeur §4d corrigé) :
 *  brûler le code de secours → révoquer TOUTES les sessions de l'admin →
 *  régénérer le secret TOTP → créer la session d'urgence → audit.
 *
 *  LES 5 ÉCRITURES SONT ATOMIQUES (withWriteLock + $transaction + `tx` passé
 *  à chaque helper). Avant la correction, les 3 premières étaient séquentielles
 *  hors transaction : un crash entre brûler et ré-enrôler laissait un code
 *  BRÛLÉ sans nouveau secret (admin dégradé, récupérable seulement via le
 *  2ᵉ code). Désormais, tout échec → ROLLBACK COMPLET :
 *    - le code de secours reste utilisable (usedAt null) ;
 *    - les sessions restent actives (aucune révocation persistée) ;
 *    - le TOTP actuel reste valide (secret inchangé) ;
 *    - aucune trace d'audit partielle (AdminAudit append-only intact).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { db } from "@/lib/db";
import { withWriteLock } from "@/lib/mbote/write-mutex";
import {
  createAdminSession,
  revokeAllAdminSessions,
  writeAdminAudit,
} from "@/lib/mbote/admin-auth";
import { generateTotpSecret } from "@/lib/mbote/totp";

export interface BreakGlassArgs {
  adminUserId: number;
  adminRole: string;
  /** id du AdminRecoveryCode dont la vérification Argon2id vient de passer */
  recoveryCodeId: number;
  ip: string | null;
  userAgent: string | null;
}

export interface BreakGlassOutcome {
  sessionsRevoked: number;
  newSecret: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

/**
 * Usage valide du code de secours — ATOMIQUE. Ne jamais appeler les étapes
 * individuellement : c'est l'absence de transaction qui créait l'écart §4d.
 */
export async function executeBreakGlass(args: BreakGlassArgs): Promise<BreakGlassOutcome> {
  return withWriteLock(() =>
    db.$transaction(async (tx) => {
      // 1) brûler le code (usedAt + traçabilité ip/UA) — JAMAIS réutilisable
      await tx.adminRecoveryCode.update({
        where: { id: args.recoveryCodeId },
        data: { usedAt: new Date(), usedIp: args.ip, usedUserAgent: args.userAgent },
      });

      // 2) révoquer TOUTES les sessions actives de l'admin
      //    (helper → tx OBLIGATOIRE — invariant §4d règle 1)
      const sessionsRevoked = await revokeAllAdminSessions(args.adminUserId, "break-glass", tx);

      // 3) NOUVEAU secret TOTP (ré-enrôlement forcé — l'ancien est compromis)
      const newSecret = generateTotpSecret();
      await tx.adminUser.update({
        where: { id: args.adminUserId },
        data: { totpSecret: newSecret, totpEnrolled: false, totpLastCounter: null },
      });

      // 4) session d'urgence (helper → tx OBLIGATOIRE — invariant §4d règle 1)
      const session = await createAdminSession(
        args.adminUserId,
        { ip: args.ip, userAgent: args.userAgent },
        tx
      );

      // 5) audit — MÊME tx (jamais le client global dans une tx ouverte :
      //    deadlock, occurrence 1 de la classe §4d)
      await writeAdminAudit({
        tx,
        actorId: args.adminUserId,
        actorRole: args.adminRole,
        action: "break-glass",
        targetType: "AdminUser",
        targetId: String(args.adminUserId),
        after: {
          recoveryCodeId: args.recoveryCodeId,
          sessionsRevoked,
          newSecretIssued: true,
          totpEnrolled: false,
        },
        ip: args.ip,
        userAgent: args.userAgent,
      });

      return {
        sessionsRevoked,
        newSecret,
        sessionToken: session.sessionToken,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      };
    })
  );
}
