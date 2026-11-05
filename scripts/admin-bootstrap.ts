/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  admin:bootstrap — création du PREMIER super-admin (ADM Étape 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Usage :
 *    DATABASE_URL="file:$(pwd)/db/custom.db" bun run admin:bootstrap -- --email=admin@mbote.test
 *    # mot de passe imposé (scripté) : --password='…'   (sinon généré, affiché 1 fois)
 *
 *  Garde-fous (directive Étape 3, testés dans tests/admin-bootstrap.test.ts) :
 *   - REFUSÉ si un AdminUser (hors pseudo-user `system`) existe déjà ;
 *   - REFUSÉ si NODE_ENV=production sans flag explicite --allow-prod ;
 *   - REFUSÉ si --allow-prod est passé HORS production (flag sans objet) ;
 *   - crée le premier AdminUser role=super-admin, totpEnrolled=false ;
 *   - affiche UNE SEULE FOIS : QR TOTP (ASCII), secret base32, mot de passe,
 *     2 codes de secours (stockés HASHÉS Argon2id — jamais en clair en DB) ;
 *   - écrit AdminAudit{action:'bootstrap', actorId:system_user_id,
 *     targetType:'AdminUser', targetId:<new_id>} dans la MÊME transaction.
 *
 *  Secrets affichés : le stdout du CLI EST le canal de première divulgation —
 *  il ne contient AUCUN hash, et la DB ne contient AUCUN secret en clair.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseArgs } from "util";
import { randomBytes } from "crypto";
import { hash as argon2Hash } from "@node-rs/argon2";
import QRCode from "qrcode";
import { PrismaClient } from "@prisma/client";
import { buildOtpauthUri, base32Encode, generateTotpSecret } from "../src/lib/mbote/totp";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    email: { type: "string" },
    password: { type: "string" },
    "allow-prod": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(`REFUSÉ : ${msg}`);
  process.exit(1);
}

if (values.help || !values.email) {
  console.log(
    `Usage :
  DATABASE_URL="file:…/custom.db" bun run admin:bootstrap -- --email=<email> [--password=<mot-de-passe>]

Crée le PREMIER super-admin (refusé si un AdminUser existe déjà).
En production, exige le flag explicite --allow-prod (double confirmation).`
  );
  process.exit(values.help ? 0 : 1);
}

const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !values["allow-prod"]) {
  fail("NODE_ENV=production sans --allow-prod — relancez avec --allow-prod pour confirmer.");
}
if (!isProduction && values["allow-prod"]) {
  fail("--allow-prod n'a de sens qu'en production (NODE_ENV=production) — flag sans objet ici.");
}

const email = (values.email as string).trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`email invalide : ${values.email}`);

const password =
  typeof values.password === "string" && values.password.length >= 16
    ? values.password
    : randomBytes(18).toString("base64url"); // ~24 chars — affiché UNE fois

const db = new PrismaClient();

function recoveryCode(): string {
  // 20 octets (160 bits) → 32 chars base32 (RFC 4648) → 8 groupes de 4
  const raw = base32Encode(new Uint8Array(randomBytes(20)));
  return (raw.match(/.{1,4}/g) ?? []).join("-");
}
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

try {
  const existing = await db.adminUser.count({ where: { role: { not: "system" } } });
  if (existing > 0) {
    fail(`un AdminUser existe déjà (${existing}) — bootstrap réservé au PREMIER compte.`);
  }

  const system = await db.adminUser.findFirst({ where: { role: "system" }, select: { id: true, role: true } });
  if (!system) fail("SYSTEM_ACTOR_MISSING (migration 0004 non appliquée ?)");

  const passwordHash = await argon2Hash(password);
  const totpSecret = generateTotpSecret();
  const codes = [recoveryCode(), recoveryCode()];
  const codeHashes = await Promise.all(codes.map((c) => argon2Hash(normalizeCode(c))));

  const created = await db.$transaction(async (tx) => {
    const user = await tx.adminUser.create({
      data: {
        email,
        passwordHash,
        totpSecret,
        totpEnrolled: false,
        role: "super-admin",
      },
    });
    for (const h of codeHashes) {
      await tx.adminRecoveryCode.create({ data: { adminUserId: user.id, codeHash: h } });
    }
    await tx.adminAudit.create({
      data: {
        actorId: system.id,
        actorRole: system.role,
        action: "bootstrap",
        targetType: "AdminUser",
        targetId: String(user.id),
        afterJson: JSON.stringify({ email, role: "super-admin", totpEnrolled: false, recoveryCodes: 2 }),
      },
    });
    return user;
  });

  const otpauthUri = buildOtpauthUri(email, totpSecret);
  const qrAscii = await QRCode.toString(otpauthUri, { type: "terminal", small: true });

  console.log(
    `✅ Super-admin créé : id=${created.id} role=super-admin totpEnrolled=false

⚠️  SECRETS AFFICHÉS UNE SEULE FOIS — à stocker dans un gestionnaire de mots de passe.

Mot de passe : ${password}

── Enrôlement TOTP (obligatoire à la première connexion) ──
Scannez ce QR dans votre app authenticator (Aegis, 1Password, Google Authenticator…) :
${qrAscii}
Secret base32 (saisie manuelle) : ${totpSecret}
URI otpauth : ${otpauthUri}

── Codes de secours break-glass (2, chacun utilisable UNE fois) ──
1. ${codes[0]}
2. ${codes[1]}

── Instructions ──
1. Installez une app authenticator et scannez le QR ci-dessus.
2. Connectez-vous sur le panneau admin avec email + mot de passe + code TOTP
   (6 chiffres). Le PREMIER login validé finalise l'enrôlement (totpEnrolled=true).
3. Conservez les 2 codes de secours hors ligne : un code consommé = un téléphone
   perdu récupérable (bypass TOTP + ré-enrôlement forcé).
Audit : ligne AdminAudit{action=bootstrap} écrite (append-only).`
  );
} finally {
  await db.$disconnect();
}
