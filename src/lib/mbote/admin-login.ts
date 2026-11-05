/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  admin-login — vérification des identifiants admin (ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Un SEUL round-trip : email + password + TOTP (directive Étape 3).
 *  TOUT échec (email inconnu, mot de passe faux, TOTP faux/rejoué/expiré,
 *  admin désactivé, secret absent) → même issue « invalid credentials » —
 *  aucune indication sur la cause.
 *
 *  Anti-timing : quand l'utilisateur ou le hash manque, une vérification
 *  Argon2id FICTIVE est quand même exécutée (hash leurre calculé au premier
 *  appel) — le temps de réponse ne distingue pas « email inconnu » de
 *  « mot de passe faux ».
 *
 *  Anti-rejeu TOTP : le compteur 30 s de chaque code VALIDÉ est persisté
 *  (`AdminUser.totpLastCounter`) — un code de compteur ≤ est un rejeu.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes } from "crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { AdminUser, PrismaClient } from "@prisma/client";
import { verifyTotp } from "@/lib/mbote/totp";

export type { AdminUser };

/** Hash leurre (chargé paresseusement) pour égaliser le coût Argon2id. */
let dummyHash: string | null = null;
async function antiTimingVerify(hashOrNull: string | null, password: string): Promise<boolean> {
  if (!hashOrNull) {
    dummyHash ??= await argon2Hash(randomBytes(24).toString("base64url"));
    await argon2Verify(dummyHash, password).catch(() => false);
    return false;
  }
  return argon2Verify(hashOrNull, password).catch(() => false);
}

export interface LoginInput {
  email: string;
  password: string;
  totpCode: string;
}

export type LoginOutcome =
  | { ok: true; user: AdminUser; totpCounter: number; totpJustEnrolled: boolean }
  | { ok: false };

/**
 * Vérifie email + password (Argon2id) + TOTP (fenêtre ±1, anti-rejeu).
 * Le premier login valide (TOTP pas encore validé une fois) bascule
 * `totpEnrolled` à true et le signale via `totpJustEnrolled` (audit dédié).
 */
export async function verifyAdminLogin(
  prisma: PrismaClient,
  input: LoginInput
): Promise<LoginOutcome> {
  const email = (input.email ?? "").trim().toLowerCase();
  const password = typeof input.password === "string" ? input.password : "";
  const user = email
    ? await prisma.adminUser.findUnique({ where: { email } })
    : null;

  // TOUT chemin d'échec passe par antiTimingVerify (coût constant-ish)
  if (!user || user.disabledAt || !user.passwordHash || !user.totpSecret) {
    await antiTimingVerify(user?.passwordHash ?? null, password);
    return { ok: false };
  }

  const passwordOk = await antiTimingVerify(user.passwordHash, password);
  if (!passwordOk) return { ok: false };

  const t = verifyTotp(user.totpSecret, input.totpCode ?? "", {
    lastCounter: user.totpLastCounter ?? null,
  });
  if (!t.ok || t.counter === null) return { ok: false };

  const totpJustEnrolled = !user.totpEnrolled;
  if (totpJustEnrolled) {
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { totpEnrolled: true, totpLastCounter: t.counter },
    });
  } else {
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { totpLastCounter: t.counter },
    });
  }
  return { ok: true, user, totpCounter: t.counter, totpJustEnrolled };
}

/** Mise à jour de l'anti-rejeu quand la vérification a échoué côté appelant. */
export async function persistTotpCounter(
  prisma: PrismaClient,
  adminUserId: number,
  counter: number
): Promise<void> {
  await prisma.adminUser.update({ where: { id: adminUserId }, data: { totpLastCounter: counter } });
}
