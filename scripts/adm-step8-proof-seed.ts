/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step8-proof-seed — environnement de preuve REJOUABLE (ADM Étape 8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prépare une DB de preuve dédiée pour capturer les preuves navigateur/curl
 *  du journal d'audit (docs/proofs/ADM-step8.md).
 *
 *  Usage (depuis le worktree) :
 *   DATABASE_URL="file:$(pwd)/db/adm-step8-proof.db" bun scripts/adm-step8-proof-seed.ts
 *
 *  Le script : migrate deploy → 4 admins (TOTP enrôlé, secrets connus du
 *  runner) → journal d'audit figuré : warn cible user (before/after JSON +
 *  justification §6), hide post (moderator), entrée backdatée 48 h (filtre
 *  since), 25 entrées « walk » (pagination 20+5, recherche cible), 10 001
 *  « bulk_noise » (dépassement export → 422). Idempotent : purge avant.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { hash as argon2Hash } from "@node-rs/argon2";
import { generateTotpSecret } from "../src/lib/mbote/totp";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("adm-step8-proof.db")) {
  console.error(
    "REFUS : DATABASE_URL doit pointer sur la DB de preuve dédiée :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-step8-proof.db" bun scripts/adm-step8-proof-seed.ts\n' +
      ` (reçu : ${url || "non défini"} — DEV-SETUP §2a)`
  );
  process.exit(1);
}

const db = new PrismaClient({ datasources: { db: { url } } });

async function main(): Promise<void> {
  mkdirSync(join(process.cwd(), "db"), { recursive: true });
  console.log("== migrate deploy ==");
  Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["inherit", "inherit", "inherit"],
  });

  console.log("== purge fixtures précédentes (idempotence) ==");
  await db.adminSession.deleteMany({});
  await db.adminAudit.deleteMany({});
  await db.adminRecoveryCode.deleteMany({});
  await db.adminUser.deleteMany({});

  console.log("== admins (secrets affichés UNE FOIS — environnement de preuve jetable) ==");
  const mkAdmin = async (email: string, role: string, password: string) => {
    const secret = generateTotpSecret();
    await db.adminUser.create({
      data: { email, role, passwordHash: await argon2Hash(password), totpSecret: secret, totpEnrolled: true },
    });
    console.log(`  ${role.padEnd(12)} ${email}  TOTP_SECRET=${secret}`);
    return secret;
  };
  const PASSWORD = "Step8-Proof-Passw0rd!";
  const saSecret = await mkAdmin("super@step8.proof", "super-admin", `${PASSWORD}.sa`);
  const modSecret = await mkAdmin("moderator@step8.proof", "moderator", `${PASSWORD}.moderator`);
  const supportSecret = await mkAdmin("support@step8.proof", "support", `${PASSWORD}.support`);
  const auditorSecret = await mkAdmin("auditor@step8.proof", "auditor", `${PASSWORD}.auditor`);

  writeFileSync(
    join(process.cwd(), "db", "adm-step8-secrets.json"),
    JSON.stringify(
      {
        password: PASSWORD,
        admins: {
          "super@step8.proof": { role: "super-admin", password: `${PASSWORD}.sa`, totpSecret: saSecret },
          "moderator@step8.proof": { role: "moderator", password: `${PASSWORD}.moderator`, totpSecret: modSecret },
          "support@step8.proof": { role: "support", password: `${PASSWORD}.support`, totpSecret: supportSecret },
          "auditor@step8.proof": { role: "auditor", password: `${PASSWORD}.auditor`, totpSecret: auditorSecret },
        },
      },
      null,
      2
    )
  );

  const ids = new Map<string, number>();
  for (const u of await db.adminUser.findMany({ select: { id: true, role: true } })) {
    ids.set(u.role, u.id);
  }
  const mustRole = (role: string): number => {
    const id = ids.get(role);
    if (!id) throw new Error(`admin ${role} absent du seed`);
    return id;
  };
  const auditorId = mustRole("auditor");
  const moderatorId = mustRole("moderator");
  const supportId = mustRole("support");

  console.log("== utilisateurs figuratifs (cibles d'audit — identités publiques) ==");
  const warnUser = await db.user.create({
    data: { pubkey: "step8-warn-target-pubkey-0123456789abcdef", nickname: "Alice Kinshasa" },
  });
  await db.user.create({ data: { pubkey: "step8-old-target-pubkey", nickname: "Vieux Compte" } });

  console.log("== journal d'audit figuré ==");
  const now = Date.now();
  let seq = 0;
  const mkAudit = async (o: {
    action: string;
    targetType?: string;
    targetId?: string;
    actorId?: number;
    actorRole?: string;
    back?: number; // ms
    before?: string;
    after?: string;
    justification?: string;
  }) => {
    const r = await db.adminAudit.create({
      data: {
        actorId: o.actorId ?? auditorId,
        actorRole: o.actorRole ?? "auditor",
        action: o.action,
        targetType: o.targetType ?? "user",
        targetId: o.targetId ?? warnUser.pubkey,
        beforeJson: o.before ?? null,
        afterJson: o.after ?? null,
        justification: o.justification ?? null,
        ip: "10.91.7.42",
        userAgent: "proof-step8 (Chromium headless)",
        createdAt: new Date(now - (o.back ?? seq * 1000) - seq),
      },
    });
    seq++;
    return r;
  };

  // entrée RICHE (fiche détail : before/after JSON, justification §6)
  const warnRow = await mkAudit({
    action: "warn",
    actorId: moderatorId,
    actorRole: "moderator",
    justification: "SPAM: harnais É8 — justification warn ≥ 20 caractères",
    before: JSON.stringify({ warnings: 0, suspendedAt: null }),
    after: JSON.stringify({ warnings: 1, warnedAt: now }),
  });
  // hide post (moderator) — targetType post : PAS de lien fiche (arbitrage §14.5)
  await mkAudit({
    action: "hide",
    targetType: "post",
    targetId: "step8-post-cuid-0001",
    actorId: moderatorId,
    actorRole: "moderator",
    justification: "SPAM: contenu répété — masquage après vérification des 3 signalements",
  });
  // backdatée 48 h (filtre since=24h l'exclut)
  await mkAudit({
    action: "warn",
    targetId: "step8-old-target-pubkey",
    back: 48 * 3600_000,
    actorId: supportId,
    actorRole: "support",
  });
  // 25 « walk » (pagination 20 + 5, recherche cible e2e)
  for (let i = 0; i < 25; i++) {
    await mkAudit({ action: "walk", targetId: `step8-walk-${String(i).padStart(3, "0")}` });
  }
  // 10 001 « bulk_noise » (export sans filtre → 422, arbitrage §14.3)
  for (let batch = 0; batch < 10_001; batch += 500) {
    const n = Math.min(500, 10_001 - batch);
    await db.adminAudit.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        actorId: auditorId,
        actorRole: "auditor",
        action: "bulk_noise",
        targetType: "post",
        targetId: `step8-bulk-${batch + i}`,
      })),
    });
  }

  const total = await db.adminAudit.count();
  console.log(`== journal : ${total} entrées (10 001 bulk_noise + ${total - 10_001} figurées) ==`);
  console.log(JSON.stringify({ warnAuditId: warnRow.id, warnTargetPubkey: warnUser.pubkey }));
  writeFileSync(
    join(process.cwd(), "db", "adm-step8-fixtures.json"),
    JSON.stringify({ warnAuditId: warnRow.id, warnTargetPubkey: warnUser.pubkey, total })
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
