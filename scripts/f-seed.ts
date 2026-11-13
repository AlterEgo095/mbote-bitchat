/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  f-seed — seed de la DB de preuve F (vague F — corrections UI)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Seeded dans db/f-ui-fixes.db (DATABASE_URL) :
 *    · 3 admins TOTP : sa + sa2 (super-admins) et mod (moderator) — creds
 *      dans db/f-secrets.json (E2E LOCAL UNIQUEMENT — convention harness).
 *    · 1 intention four-eyes PENDING créée par sa avec une session de seed
 *      (« f-seed-session-1 ») : vue par sa dans une session UI ≠ seed →
 *      canCancel=false/canApprove=false → branche de diagnostic #72 exacte.
 *
 *  Commande : DATABASE_URL="file:…/f-ui-fixes.db" bun scripts/f-seed.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { hash as argon2Hash } from "@node-rs/argon2";
import { generateTotpSecret } from "../src/lib/mbote/totp";

const db = new PrismaClient();

async function main(): Promise<void> {
  const secrets: Record<string, { email: string; password: string; totpSecret: string; role: string }> = {};
  const password = "F-Proof-Passw0rd!";

  const defs = [
    { email: "sa@f-proof.test", role: "super-admin" },
    { email: "sa2@f-proof.test", role: "super-admin" },
    { email: "mod@f-proof.test", role: "moderator" },
  ];
  for (const d of defs) {
    const secret = generateTotpSecret();
    const admin = await db.adminUser.upsert({
      where: { email: d.email },
      create: {
        email: d.email,
        role: d.role,
        passwordHash: await argon2Hash(password),
        totpSecret: secret,
        totpEnrolled: true,
      },
      update: { totpEnrolled: true, disabledAt: null, totpLastCounter: null, totpSecret: secret },
    });
    secrets[d.email] = { email: d.email, password, totpSecret: secret, role: d.role };
    await db.adminRecoveryCode.deleteMany({ where: { adminUserId: admin.id } });
    for (const code of ["FPROOFCODEAAAA0000", "FPROOFCODEBBBB1111"]) {
      await db.adminRecoveryCode.create({
        data: { adminUserId: admin.id, codeHash: await argon2Hash(code) },
      });
    }
  }

  // intention four-eyes PENDING par sa (session de seed ≠ toute session UI)
  const sa = await db.adminUser.findUniqueOrThrow({ where: { email: "sa@f-proof.test" } });
  await db.pendingAction.deleteMany({ where: { targetId: "f-seed-post-1" } });
  await db.pendingAction.create({
    data: {
      actionType: "purge_post",
      targetType: "post",
      targetId: "f-seed-post-1",
      payloadJson: JSON.stringify({ nickname: "Cible F", snippet: "contenu seed preuve F" }),
      justification: "SPAM: même contenu posté dix fois en une heure (seed preuve F)",
      status: "pending",
      createdById: sa.id,
      createdBySessionId: "f-seed-session-1",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const out = join(process.cwd(), "db", "f-secrets.json");
  writeFileSync(out, JSON.stringify(secrets, null, 2));
  console.log(
    `f-seed OK — 3 admins TOTP + 1 intention four-eyes (pending, sa/f-seed-session-1) · secrets : ${out}`
  );
}

main()
  .catch((e) => {
    console.error("f-seed ÉCHEC :", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
