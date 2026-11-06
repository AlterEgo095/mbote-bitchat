/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step7-proof-seed — environnement de preuve REJOUABLE (ADM Étape 7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prépare une DB de preuve dédiée pour capturer les preuves navigateur/curl
 *  de la gestion utilisateurs (docs/proofs/ADM-step7.md).
 *
 *  Usage (depuis le worktree) :
 *   DATABASE_URL="file:$(pwd)/db/adm-step7-proof.db" bun scripts/adm-step7-proof-seed.ts
 *
 *  Le script : migrate deploy → 4 admins (TOTP enrôlé, secrets connus du
 *  rapport) → fixtures utilisateurs : alice (fiche riche avec bio + posts +
 *  reports), cible de suspension avec clé privée JWK EXPORTÉE (la preuve
 *  « publication refusée 403 » est signée par cette clé côté runner), compte
 *  poids 3 / poids 1 (tri reports), ancien compte -48 h (filtre période),
 *  22 fillers (pagination 20+). Idempotent : purge avant insertion.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { hash as argon2Hash } from "@node-rs/argon2";
import { generateTotpSecret } from "../src/lib/mbote/totp";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("adm-step7-proof.db")) {
  console.error(
    "REFUS : DATABASE_URL doit pointer sur la DB de preuve dédiée :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-step7-proof.db" bun scripts/adm-step7-proof-seed.ts\n' +
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
  await db.userWarning.deleteMany({});
  await db.report.deleteMany({});
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
  const PASSWORD = "Step7-Proof-Passw0rd!";
  const saSecret = await mk("super@step7.proof", "super-admin", `${PASSWORD}.sa`);
  const modSecret = await mk("moderator@step7.proof", "moderator", `${PASSWORD}.moderator`);
  const supportSecret = await mk("support@step7.proof", "support", `${PASSWORD}.support`);
  const auditorSecret = await mk("auditor@step7.proof", "auditor", `${PASSWORD}.auditor`);

  // clé privée EXPORTÉE de la cible de suspension : le runner signe un post
  // RÉEL avec (preuve « publication refusée 403 pendant la suspension »).
  const suspPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const suspPrivJwk = await crypto.subtle.exportKey("jwk", suspPair.privateKey);
  const suspPubkey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("raw", suspPair.publicKey))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  writeFileSync(
    join(process.cwd(), "db", "adm-step7-secrets.json"),
    JSON.stringify(
      {
        password: PASSWORD,
        admins: {
          "super@step7.proof": { role: "super-admin", password: `${PASSWORD}.sa`, totpSecret: saSecret },
          "moderator@step7.proof": { role: "moderator", password: `${PASSWORD}.moderator`, totpSecret: modSecret },
          "support@step7.proof": { role: "support", password: `${PASSWORD}.support`, totpSecret: supportSecret },
          "auditor@step7.proof": { role: "auditor", password: `${PASSWORD}.auditor`, totpSecret: auditorSecret },
        },
        suspTarget: { pubkey: suspPubkey, privJwk: suspPrivJwk, nickname: "Cible Susp" },
      },
      null,
      2
    )
  );

  console.log("== fixtures utilisateurs ==");
  const HOUR = 3600e3;
  const alice = await db.user.create({
    data: {
      pubkey: "step7-alice-pubkey-0123456789abcdef",
      nickname: "Alice Kinshasa",
      bio: "Vendeuse de tissus au marché central — compte public de démonstration.",
    },
  });
  const bob = await db.user.create({ data: { pubkey: "step7-bob-pubkey", nickname: "Bob Lubumbashi" } });
  const carol = await db.user.create({ data: { pubkey: "step7-carol-pubkey", nickname: "Carol Goma" } });

  // cible de suspension (clé réelle — post signé par le runner)
  const suspUser = await db.user.create({
    data: { pubkey: suspPubkey, nickname: "Cible Susp" },
  });

  // compte poids 3 (tri reports) + poids 1
  const p3 = await db.user.create({ data: { pubkey: "step7-poids3-pubkey", nickname: "Rep Poids Trois" } });
  const p1 = await db.user.create({ data: { pubkey: "step7-poids1-pubkey", nickname: "Rep Poids Un" } });
  const post3 = await db.post.create({ data: { authorId: p3.id, content: "Post signalé trois fois — tri reports en tête" } });
  const post1 = await db.post.create({ data: { authorId: p1.id, content: "Post signalé une fois" } });

  // signaleurs réels
  const reporters: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await db.user.create({
      data: { pubkey: `step7-signaleur-${i}-pubkey`, nickname: `Signaleur ${i + 1}` },
    });
    reporters.push(r.pubkey);
  }
  let rn = 0;
  const mkReport = (targetId: string, reason = "spam") =>
    db.report.create({
      data: { reporterKey: reporters[rn++] ?? "step7-rep-x", targetKind: "post", targetId, reason },
    });
  await mkReport(post3.id);
  await mkReport(post3.id);
  await mkReport(post3.id);
  await mkReport(post1.id, "harassment");

  // alice : 3 posts (colonne « posts » de l'annuaire) + 1 report ouvert
  // (fiche : « reports ouverts reçus → traiter dans la file »)
  for (let i = 0; i < 3; i++) {
    await db.post.create({ data: { authorId: alice.id, content: `Post public d'Alice n°${i} — tissus wax disponibles au marché` } });
  }
  const alicePost = await db.post.create({
    data: { authorId: alice.id, content: "Post d'Alice signalé une fois par erreur — à classer sans suite" },
  });
  await mkReport(alicePost.id, "other");

  // ancien compte -48 h (filtre période d'inscription)
  const old = await db.user.create({ data: { pubkey: "step7-oldtimer-pubkey", nickname: "Ancien Compte" } });
  await db.user.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 48 * HOUR) } });

  // 22 fillers (pagination : page 1 = 20, page 2 = le reste)
  for (let i = 1; i <= 22; i++) {
    await db.user.create({
      data: { pubkey: `step7-filler-${String(i).padStart(2, "0")}-pubkey`, nickname: `zz-filler-${String(i).padStart(2, "0")}` },
    });
  }

  console.log("== vérification ==");
  const counts = {
    admins: await db.adminUser.count(),
    users: await db.user.count(),
    posts: await db.post.count(),
    reportsOuverts: await db.report.count({ where: { handledById: null } }),
    suspensionCible: suspUser.nickname,
    suspPubkeyPrefix: suspPubkey.slice(0, 12),
  };
  console.log(JSON.stringify(counts));
  if (counts.users !== 22 + 7 + 5 || counts.reportsOuverts !== 5) {
    throw new Error(`fixtures incohérentes : users=${counts.users} (attendu 34), reports=${counts.reportsOuverts} (attendu 5)`);
  }
  console.log("OK — lancer ensuite les deux apps en BUILD PRODUCTION (DEV-SETUP §2c).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
