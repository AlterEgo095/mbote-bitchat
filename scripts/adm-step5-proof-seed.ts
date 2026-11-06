/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step5-proof-seed — environnement de preuve REJOUABLE (ADM Étape 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prépare une DB de preuve dédiée + le fichier backup-status, pour capturer
 *  les preuves navigateur/curl du dashboard (docs/proofs/ADM-step5.md).
 *
 *  Usage (depuis le worktree) :
 *   DATABASE_URL="file:$(pwd)/db/adm-step5-proof.db" \
 *   STEP5_BACKUP_FILE="$(pwd)/db/adm-step5-backup-status.json" \
 *   bun scripts/adm-step5-proof-seed.ts
 *
 *  Le script : migrate deploy → 3 admins (TOTP enrôlé, secrets connus du
 *  rapport) → activité réseau (2 actifs 24 h, 2 actifs 7 j, 1 inactif) →
 *  2 reports ouverts + 1 pris en charge → fichier backup frais.
 *  Idempotent : purge les fixtures avant insertion.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { hash as argon2Hash } from "@node-rs/argon2";
import { generateTotpSecret } from "../src/lib/mbote/totp";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("adm-step5-proof.db")) {
  console.error(
    "REFUS : DATABASE_URL doit pointer sur la DB de preuve dédiée :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-step5-proof.db" bun scripts/adm-step5-proof-seed.ts\n' +
      ` (reçu : ${url || "non défini"} — DEV-SETUP §2a)`
  );
  process.exit(1);
}
const BACKUP_FILE = process.env.STEP5_BACKUP_FILE ?? join(process.cwd(), "db", "adm-step5-backup-status.json");

const db = new PrismaClient({ datasources: { db: { url } } });

async function main(): Promise<void> {
  mkdirSync(join(process.cwd(), "db"), { recursive: true });
  console.log("== migrate deploy ==");
  Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["inherit", "inherit", "inherit"],
  });

  console.log("== purge fixtures précédentes (idempotence) ==");
  await db.report.deleteMany({});
  await db.directMessage.deleteMany({});
  await db.post.deleteMany({});
  await db.user.deleteMany({});
  await db.adminSession.deleteMany({});
  await db.adminAudit.deleteMany({});
  await db.adminRecoveryCode.deleteMany({});
  await db.adminUser.deleteMany({});

  console.log("== admins (secrets affichés UNE FOIS ici — environnement de preuve jetable) ==");
  const mk = async (email: string, role: string, password: string) => {
    const secret = generateTotpSecret();
    await db.adminUser.create({
      data: { email, role, passwordHash: await argon2Hash(password), totpSecret: secret, totpEnrolled: true },
    });
    console.log(`  ${role.padEnd(12)} ${email}  TOTP_SECRET=${secret}`);
    return secret;
  };
  const PASSWORD = "Step5-Proof-Passw0rd!";
  const saSecret = await mk("super@step5.proof", "super-admin", `${PASSWORD}.sa`);
  const supportSecret = await mk("support@step5.proof", "support", `${PASSWORD}.support`);
  const auditorSecret = await mk("auditor@step5.proof", "auditor", `${PASSWORD}.auditor`);
  // secrets consommés par scripts/adm-step5-proof-run.sh (env de preuve jetable)
  writeFileSync(
    join(process.cwd(), "db", "adm-step5-secrets.json"),
    JSON.stringify(
      {
        password: PASSWORD,
        admins: {
          "super@step5.proof": { role: "super-admin", password: `${PASSWORD}.sa`, totpSecret: saSecret },
          "support@step5.proof": { role: "support", password: `${PASSWORD}.support`, totpSecret: supportSecret },
          "auditor@step5.proof": { role: "auditor", password: `${PASSWORD}.auditor`, totpSecret: auditorSecret },
        },
      },
      null,
      2
    )
  );

  console.log("== activité réseau : 2 actifs 24 h, 2 actifs 7 j, 1 inactif ==");
  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const mkUser = (pubkey: string, nickname: string) =>
    db.user.create({ data: { pubkey, nickname }, select: { id: true, pubkey: true } });
  const u1 = await mkUser("step5-u1-pubkey", "Kin Post Récent");
  await db.post.create({ data: { authorId: u1.id, content: "post 1 h", createdAt: new Date(Date.now() - 1 * HOUR) } });
  const u2 = await mkUser("step5-u2-pubkey", "Lubumbashi DM");
  await db.directMessage.create({
    data: {
      senderKey: u2.pubkey,
      recipientKey: "step5-peer-pubkey",
      iv: "c3RlcDUtaXY9PQ==",
      ciphertext: "c3RlcDUtY2lwaGVydGV4dC1kZW1v",
      createdAt: new Date(Date.now() - 2 * HOUR),
    },
  });
  const u3 = await mkUser("step5-u3-pubkey", "Goma Post 3j");
  await db.post.create({ data: { authorId: u3.id, content: "post 3 j", createdAt: new Date(Date.now() - 3 * DAY) } });
  const u4 = await mkUser("step5-u4-pubkey", "Bukavu DM 5j");
  await db.directMessage.create({
    data: {
      senderKey: "step5-peer2-pubkey",
      recipientKey: u4.pubkey,
      iv: "c3RlcDUtaXYyPT0=",
      ciphertext: "c3RlcDUtY2lwaGVydGV4dC0y",
      createdAt: new Date(Date.now() - 5 * DAY),
    },
  });
  const u5 = await mkUser("step5-u5-pubkey", "Inactif 10j");
  await db.post.create({ data: { authorId: u5.id, content: "post 10 j", createdAt: new Date(Date.now() - 10 * DAY) } });

  console.log("== reports : 2 ouverts, 1 pris en charge ==");
  const sa = await db.adminUser.findUnique({ where: { email: "super@step5.proof" } });
  if (!sa) throw new Error("super-admin absent");
  await db.report.create({ data: { reporterKey: "step5-r1", targetKind: "post", targetId: "post-r1", reason: "spam" } });
  await db.report.create({
    data: { reporterKey: "step5-r2", targetKind: "post", targetId: "post-r2", reason: "harassment" },
  });
  await db.report.create({
    data: {
      reporterKey: "step5-r3",
      targetKind: "post",
      targetId: "post-r3",
      reason: "spam",
      status: "actioned",
      handledAt: new Date(),
      handledById: sa.id,
    },
  });

  console.log("== fichier backup frais ==");
  writeFileSync(BACKUP_FILE, JSON.stringify({ state: "ok", at: new Date(Date.now() - 3600e3).toISOString() }));

  console.log("== vérification ==");
  const counts = {
    admins: await db.adminUser.count(),
    users: await db.user.count(),
    posts: await db.post.count(),
    dms: await db.directMessage.count(),
    reportsOuverts: await db.report.count({ where: { handledById: null } }),
    sessions: await db.adminSession.count(),
  };
  console.log(JSON.stringify(counts));
  console.log(`BACKUP_FILE=${BACKUP_FILE}`);
  console.log("OK — lancer ensuite les deux apps en BUILD PRODUCTION (DEV-SETUP §2c) :");
  console.log('  app principale : DATABASE_URL=… BACKUP_STATUS_PATH=… ADMIN_INTERNAL_TOKEN=… bunx next build && bunx next start -p 3101');
  console.log('  panneau admin  : (admin/) DATABASE_URL=… ADMIN_INTERNAL_TOKEN=… BACKEND_INTERNAL_URL=http://127.0.0.1:3101 bunx next build && bunx next start -p 3102');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
