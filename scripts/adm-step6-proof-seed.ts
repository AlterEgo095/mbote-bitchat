/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step6-proof-seed — environnement de preuve REJOUABLE (ADM Étape 6)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Prépare une DB de preuve dédiée pour capturer les preuves navigateur/curl
 *  de la queue de modération (docs/proofs/ADM-step6.md).
 *
 *  Usage (depuis le worktree) :
 *   DATABASE_URL="file:$(pwd)/db/adm-step6-proof.db" bun scripts/adm-step6-proof-seed.ts
 *
 *  Le script : migrate deploy → 4 admins (TOTP enrôlé, secrets connus du
 *  rapport) → fixtures queue : cible « lourde » 5 reports (badge ROUGE ≥ 5),
 *  cible 3 reports (tri poids), cible 1 report, report de commentaire,
 *  report de 48 h (filtre période), 22 cibles à 1 report (pagination page 2).
 *  Idempotent : purge les fixtures avant insertion.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { hash as argon2Hash } from "@node-rs/argon2";
import { generateTotpSecret } from "../src/lib/mbote/totp";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("adm-step6-proof.db")) {
  console.error(
    "REFUS : DATABASE_URL doit pointer sur la DB de preuve dédiée :\n" +
      '  DATABASE_URL="file:$(pwd)/db/adm-step6-proof.db" bun scripts/adm-step6-proof-seed.ts\n' +
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
  const PASSWORD = "Step6-Proof-Passw0rd!";
  const saSecret = await mk("super@step6.proof", "super-admin", `${PASSWORD}.sa`);
  const modSecret = await mk("moderator@step6.proof", "moderator", `${PASSWORD}.moderator`);
  const supportSecret = await mk("support@step6.proof", "support", `${PASSWORD}.support`);
  const auditorSecret = await mk("auditor@step6.proof", "auditor", `${PASSWORD}.auditor`);
  writeFileSync(
    join(process.cwd(), "db", "adm-step6-secrets.json"),
    JSON.stringify(
      {
        password: PASSWORD,
        admins: {
          "super@step6.proof": { role: "super-admin", password: `${PASSWORD}.sa`, totpSecret: saSecret },
          "moderator@step6.proof": { role: "moderator", password: `${PASSWORD}.moderator`, totpSecret: modSecret },
          "support@step6.proof": { role: "support", password: `${PASSWORD}.support`, totpSecret: supportSecret },
          "auditor@step6.proof": { role: "auditor", password: `${PASSWORD}.auditor`, totpSecret: auditorSecret },
        },
      },
      null,
      2
    )
  );

  console.log("== fixtures queue ==");
  const HOUR = 3600e3;
  const bob = await db.user.create({ data: { pubkey: "step6-bob-pubkey", nickname: "Bob Kinshasa" } });
  const carol = await db.user.create({ data: { pubkey: "step6-carol-pubkey", nickname: "Carol Lubumbashi" } });
  // signaleurs RÉELS (pseudos affichés dans la file — les reports viennent
  // d'utilisateurs authentifiés par preuve signée `report`)
  const reporters: string[] = [];
  for (let i = 0; i < 34; i++) {
    const r = await db.user.create({
      data: { pubkey: `step6-signaleur-${i}-pubkey`, nickname: `Signaleur ${i + 1}` },
    });
    reporters.push(r.pubkey);
  }
  const mkPost = (authorId: string, content: string) => db.post.create({ data: { authorId, content } });

  // cible « lourde » : 5 reports ouverts (badge ROUGE ≥ 5 — directive)
  const postE = await mkPost(carol.id, "Message répété en boucle sur tous les canaux, spam manifeste et massif");
  // cible « A » : 3 reports (tri poids décroissant — fixture de la directive)
  const postA = await mkPost(carol.id, "Contenu signalé trois fois par trois utilisateurs différents du fil");
  // cible « B » : 1 report
  const postB = await mkPost(bob.id, "Post signalé une seule fois — dispute de voisinage classique");
  // commentaire signalé (filtre type=comment)
  const parent = await mkPost(bob.id, "Discussion parente du commentaire signalé ci-dessous");
  const comment = await db.post.create({ data: { authorId: bob.id, content: "Commentaire hors-sujet et agressif envers un autre membre", parentId: parent.id } });

  let reporterN = 0;
  const mkReport = (targetKind: string, targetId: string, reason = "spam") =>
    db.report.create({
      data: {
        reporterKey: reporters[reporterN++] ?? "step6-rep-x",
        targetKind,
        targetId,
        reason,
      },
    });

  for (let i = 0; i < 5; i++) await mkReport("post", postE.id);
  for (let i = 0; i < 3; i++) await mkReport("post", postA.id);
  await mkReport("post", postB.id);
  await mkReport("comment", comment.id, "harassment");

  // report de 48 h (le filtre période 24h doit l'exclure)
  const oldPost = await mkPost(carol.id, "Ancien post signalé il y a deux jours (hors fenêtre 24 h)");
  const oldReport = await mkReport("post", oldPost.id);
  await db.report.update({
    where: { id: oldReport.id },
    data: { createdAt: new Date(Date.now() - 48 * HOUR) },
  });

  // 22 cibles à 1 report → 33 reports ouverts au total (pagination 20 + 13)
  for (let i = 0; i < 22; i++) {
    const p = await mkPost(bob.id, `Post filler de pagination ${i} — un seul signalement ouvert`);
    await mkReport("post", p.id);
  }

  console.log("== vérification ==");
  const counts = {
    admins: await db.adminUser.count(),
    users: await db.user.count(),
    posts: await db.post.count(),
    reportsOuverts: await db.report.count({ where: { handledById: null } }),
    reportsAnciens48h: 1,
    poidsAttenduPremier: 5,
  };
  console.log(JSON.stringify(counts));
  if (counts.reportsOuverts !== 33) throw new Error(`fixtures incohérentes : ${counts.reportsOuverts} ≠ 33`);
  console.log("OK — lancer ensuite les deux apps en BUILD PRODUCTION (DEV-SETUP §2c).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
