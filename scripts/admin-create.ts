/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  admin:create — création d'un compte admin ADDITIONNEL (ADM Étape 10)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Le PREMIER super-admin = `bun run admin:bootstrap` (garde « un seul »).
 *  Les SUIVANTS (modérateur, support, 2ᵉ super-admin pour le four-eyes) =
 *  CE script. L'écart code↔docs est comblé : ADMIN-RBAC §2.4 et
 *  ADMIN-ACCESS-RUNBOOK §3.1 référençaient `scripts/admin-create.ts` qui
 *  n'existait pas — constat Étape 10 (audit des docs opérateur).
 *
 *  Usage :
 *    DATABASE_URL="file:…/custom.db" bun run admin:create -- \
 *      --email=moderateur@mbote.test --role=moderator
 *    # mot de passe imposé (scripté) : --password='…'  (sinon généré, affiché 1 fois)
 *
 *  Garde-fous (miroir de admin-bootstrap.ts) :
 *   - REFUSÉ si le PREMIER AdminUser n'existe pas encore (bootstrap d'abord) ;
 *   - REFUSÉ si l'email existe déjà ;
 *   - REFUSÉ si rôle invalide (auditor | support | moderator | super-admin) ;
 *   - REFUSÉ si NODE_ENV=production sans --allow-prod (comme bootstrap) ;
 *   - rôle `system` impossible ici (réservé au seed migration 0004) ;
 *   - affiche UNE FOIS : mot de passe + secret TOTP (QR otpauth) —
 *     totpEnrolled=false → enrôlement TOTP forcé au premier login (RBAC §7.2) ;
 *   - écrit AdminAudit{action:'admin_created', actorId:system_user_id} dans la
 *     MÊME transaction (un compte sans sa trace d'audit n'existe pas).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseArgs } from "util";
import { randomBytes } from "crypto";
import { hash as argon2Hash } from "@node-rs/argon2";
import QRCode from "qrcode";
import { PrismaClient } from "@prisma/client";
import { buildOtpauthUri, generateTotpSecret } from "../src/lib/mbote/totp";

const VALID_ROLES = ["auditor", "support", "moderator", "super-admin"] as const;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    email: { type: "string" },
    role: { type: "string", default: "moderator" },
    password: { type: "string" },
    "allow-prod": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

if (values.help) {
  console.log(
    "Usage : DATABASE_URL=\"file:…/custom.db\" bun run admin:create -- --email=<email> --role=<rôle> [--password=<mot-de-passe>]\n" +
      "Rôles : auditor | support | moderator | super-admin (défaut : moderator)\n" +
      "Production : --allow-prod obligatoire (NODE_ENV=production)."
  );
  process.exit(0);
}

const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !values["allow-prod"]) {
  fail("NODE_ENV=production : re-run avec --allow-prod pour confirmer l'opération (RBAC §2.4).");
}
if (!isProduction && values["allow-prod"]) {
  fail("--allow-prod n'a de sens qu'en production (flag sans objet ici).");
}

const email = (values.email as string | undefined)?.trim().toLowerCase() ?? "";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("email invalide");

const role = values.role as string;
if (!(VALID_ROLES as readonly string[]).includes(role)) {
  fail(`rôle invalide : ${role} — valeurs : ${VALID_ROLES.join(", ")}`);
}

const password =
  typeof values.password === "string" && values.password.length >= 16
    ? values.password
    : randomBytes(18).toString("base64url"); // ~24 chars — affiché UNE fois

const db = new PrismaClient();

try {
  const bootstrapDone = await db.adminUser.count({ where: { role: { not: "system" } } });
  if (bootstrapDone === 0) {
    fail("aucun AdminUser — exécuter d'abord `bun run admin:bootstrap` (le premier compte).");
  }
  const dup = await db.adminUser.findUnique({ where: { email }, select: { id: true } });
  if (dup) fail(`email déjà pris : ${email} (AdminUser #${dup.id})`);

  const system = await db.adminUser.findFirst({ where: { role: "system" }, select: { id: true, role: true } });
  if (!system) fail("SYSTEM_ACTOR_MISSING (migration 0004 non appliquée ?)");

  const passwordHash = await argon2Hash(password);
  const totpSecret = generateTotpSecret();

  const created = await db.$transaction(async (tx) => {
    const user = await tx.adminUser.create({
      data: { email, role, passwordHash, totpSecret, totpEnrolled: false },
    });
    await tx.adminAudit.create({
      data: {
        actorId: system.id,
        actorRole: system.role,
        action: "admin_created",
        targetType: "AdminUser",
        targetId: String(user.id),
        afterJson: JSON.stringify({ email, role, totpEnrolled: false }),
      },
    });
    return user;
  });

  const otpauthUri = buildOtpauthUri(email, totpSecret);
  const qrAscii = await QRCode.toString(otpauthUri, { type: "terminal", small: true });

  console.log(
    `✅ Admin créé : id=${created.id} role=${role} totpEnrolled=false

⚠️  SECRETS AFFICHÉS UNE SEULE FOIS — à stocker dans un gestionnaire de mots de passe.

Email     : ${email}
Rôle      : ${role}
Password  : ${password}
Secret TOTP (base32) : ${totpSecret}
URI otpauth (scan l'app auth, sinon saisie manuelle du secret) :

${qrAscii}

Premier login : enrôlement TOTP forcé (RBAC §7.2). Traçabilité : AdminAudit{admin_created}.`
  );
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await db.$disconnect();
}
