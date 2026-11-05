/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  admin-session — bootstrap DEV/TEST d'une session admin (ADM Étape 0)
 * ─────────────────────────────────────────────────────────────────────────────
 *  ⚠️ OUTIL DE DÉVELOPPEMENT — REFUSÉ EN PRODUCTION (exit 1 si NODE_ENV=production).
 *  Le login (email + password + TOTP) arrive à l'Étape 3 ; d'ici là, cet outil
 *  permet de tester la rupture (endpoints session-based) localement.
 *
 *  Il crée (si absent) un AdminUser de test et une AdminSession, puis affiche
 *  le cookie et le jeton CSRF — la session vit en DB (AdminSession).
 *
 *  Usage :
 *    DATABASE_URL="file:$(pwd)/db/adm-rupture.db" \
 *      bun scripts/admin-session.ts --email dev@mbote.test --role super-admin
 *    # → Cookie: mbote_admin_session=<id>  ·  x-admin-csrf: <token>
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseArgs } from "util";
import { PrismaClient } from "@prisma/client";
import { createAdminSession, roleAtLeast } from "../src/lib/mbote/admin-auth";

const VALID_ROLES = ["auditor", "support", "moderator", "super-admin"];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    email: { type: "string" },
    role: { type: "string", default: "super-admin" },
    "ttl-hours": { type: "string", default: "8" },
    help: { type: "boolean", default: false },
  },
});

if (values.help || !values.email) {
  console.log(
    `Usage:
  bun scripts/admin-session.ts --email dev@mbote.test [--role super-admin] [--ttl-hours 8]

⚠️  DEV/TEST uniquement — refusé si NODE_ENV=production.`
  );
  process.exit(values.help ? 0 : 1);
}

if (process.env.NODE_ENV === "production") {
  console.error("REFUSÉ : bootstrap de session interdit en production (login = Étape 3).");
  process.exit(1);
}

if (!VALID_ROLES.includes(values.role ?? "")) {
  console.error(`rôle invalide (valeurs : ${VALID_ROLES.join(", ")})`);
  process.exit(1);
}

const db = new PrismaClient();

try {
  const email = (values.email as string).trim().toLowerCase();
  const role = values.role as string;
  if (!roleAtLeast(role, "auditor")) throw new Error("rôle insuffisant pour un humain");

  const user = await db.adminUser.upsert({
    where: { email },
    create: { email, role }, // passwordHash NULL → login impossible jusqu'à l'Étape 3
    update: {}, // ne change jamais un existant (idempotent)
  });

  const ttlMs = Math.max(1, Number(values["ttl-hours"] ?? 8) || 8) * 3600_000;
  const { sessionId, csrfToken, expiresAt } = await createAdminSession(user.id, {
    ip: "dev-bootstrap",
    userAgent: "scripts/admin-session.ts",
    ttlMs,
  });

  console.log(
    `✅ Session DEV créée pour ${email} (id=${user.id}, role=${role})
Cookie      : mbote_admin_session=${sessionId}
CSRF header : x-admin-csrf: ${csrfToken}
Expire      : ${expiresAt.toISOString()}
Usage curl  : curl -b "mbote_admin_session=${sessionId}" -H "x-admin-csrf: ${csrfToken}" …`
  );
} finally {
  await db.$disconnect();
}
