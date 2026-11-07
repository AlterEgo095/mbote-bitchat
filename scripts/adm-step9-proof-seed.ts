/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step9-proof-seed — environnement de preuve REJOUABLE (ADM Étape 9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prépare une DB de preuve dédiée pour les preuves navigateur/curl du
 *  FOUR-EYES (docs/proofs/ADM-step9.md).
 *
 *  Usage (depuis le worktree) :
 *   DATABASE_URL="file:$(pwd)/db/adm-step9-proof.db" bun scripts/adm-step9-proof-seed.ts
 *
 *  Le script : migrate deploy → 5 admins (DEUX super-admins — l'exigence
 *  four-eyes — TOTP enrôlé, secrets connus du runner) → cibles figuratives :
 *  user « Ban Kinshasa » avec 2 posts VISIBLES (masqués par le ban exécuté),
 *  post « à purger », user d'annulation. Idempotent : purge avant.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { hash as argon2Hash } from "@node-rs/argon2";
import { generateTotpSecret } from "../src/lib/mbote/totp";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("adm-step9-proof.db")) {
  console.error(
    "REFUS : DATABASE_URL doit pointer sur la DB de preuve dédiée :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-step9-proof.db" bun scripts/adm-step9-proof-seed.ts\n' +
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
  await db.pendingAction.deleteMany({});
  await db.adminSession.deleteMany({});
  await db.adminAudit.deleteMany({});
  await db.adminRecoveryCode.deleteMany({});
  await db.adminUser.deleteMany({});
  await db.report.deleteMany({});
  await db.post.deleteMany({});
  await db.like.deleteMany({});
  await db.userWarning.deleteMany({});
  await db.moderationAction.deleteMany({});
  await db.user.deleteMany({});

  console.log("== admins (DEUX super-admins — exigence four-eyes) ==");
  const mkAdmin = async (email: string, role: string, password: string) => {
    const secret = generateTotpSecret();
    await db.adminUser.create({
      data: { email, role, passwordHash: await argon2Hash(password), totpSecret: secret, totpEnrolled: true },
    });
    console.log(`  ${role.padEnd(12)} ${email}  TOTP_SECRET=${secret}`);
    return secret;
  };
  const PASSWORD = "Step9-Proof-Passw0rd!";
  const saSecret = await mkAdmin("super@step9.proof", "super-admin", `${PASSWORD}.sa1`);
  const sa2Secret = await mkAdmin("super2@step9.proof", "super-admin", `${PASSWORD}.sa2`);
  const modSecret = await mkAdmin("moderator@step9.proof", "moderator", `${PASSWORD}.moderator`);
  const supportSecret = await mkAdmin("support@step9.proof", "support", `${PASSWORD}.support`);
  const auditorSecret = await mkAdmin("auditor@step9.proof", "auditor", `${PASSWORD}.auditor`);

  console.log("== cibles figuratives ==");
  // user BAN — VRAIE clé ECDSA P-256 (la preuve 5b du runner publie avec la
  // clé privée exportée : un banni doit être refusé 403 AVEC signature valide)
  const banPair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  ) as CryptoKeyPair;
  const banPub = Buffer.from(
    await globalThis.crypto.subtle.exportKey("raw", banPair.publicKey)
  ).toString("base64url");
  const banPrivJwk = await globalThis.crypto.subtle.exportKey("jwk", banPair.privateKey);
  const banTarget = await db.user.create({
    data: { pubkey: banPub, nickname: "Ban Kinshasa" },
  });
  await db.post.create({
    data: { authorId: banTarget.id, content: "post 1 de Ban Kinshasa — masqué par le ban four-eyes" },
  });
  await db.post.create({
    data: { authorId: banTarget.id, content: "post 2 de Ban Kinshasa — masqué par le ban four-eyes" },
  });
  // post PURGE
  const purgeAuthor = await db.user.create({
    data: { pubkey: "step9-purge-author-pubkey", nickname: "Purge Auteur" },
  });
  const purgePost = await db.post.create({
    data: { authorId: purgeAuthor.id, content: "post à purger par four-eyes — contenu scam réservé à la preuve" },
  });
  // user CANCEL (annulation — reste actif)
  await db.user.create({
    data: { pubkey: "step9-cancel-target-pubkey", nickname: "Cancel Cible" },
  });
  // user EXPIRE (expiration — reste actif)
  await db.user.create({
    data: { pubkey: "step9-expire-target-pubkey", nickname: "Expire Cible" },
  });

  // user BROWSER (cycle complet côté navigateur — cible dédiée, les cibles
  // curl sont déjà consommées par les sections 4-7)
  const browserTarget = await db.user.create({
    data: { pubkey: "step9-browser-target-pubkey", nickname: "Browser Cible" },
  });
  await db.post.create({
    data: { authorId: browserTarget.id, content: "post de Browser Cible — ban par le cycle navigateur" },
  });

  writeFileSync(
    join(process.cwd(), "db", "adm-step9-secrets.json"),
    JSON.stringify(
      {
        password: PASSWORD,
        admins: {
          "super@step9.proof": { role: "super-admin", password: `${PASSWORD}.sa1`, totpSecret: saSecret },
          "super2@step9.proof": { role: "super-admin", password: `${PASSWORD}.sa2`, totpSecret: sa2Secret },
          "moderator@step9.proof": { role: "moderator", password: `${PASSWORD}.moderator`, totpSecret: modSecret },
          "support@step9.proof": { role: "support", password: `${PASSWORD}.support`, totpSecret: supportSecret },
          "auditor@step9.proof": { role: "auditor", password: `${PASSWORD}.auditor`, totpSecret: auditorSecret },
        },
        fixtures: {
          banTargetPubkey: banPub,
          banTargetNickname: "Ban Kinshasa",
          banTargetPrivJwk: banPrivJwk,
          purgePostId: purgePost.id,
          cancelTargetPubkey: "step9-cancel-target-pubkey",
          expireTargetPubkey: "step9-expire-target-pubkey",
          browserTargetPubkey: "step9-browser-target-pubkey",
          browserTargetNickname: "Browser Cible",
        },
      },
      null,
      2
    )
  );

  console.log("== seed OK — db/adm-step9-secrets.json écrit (2 super-admins + fixtures) ==");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
