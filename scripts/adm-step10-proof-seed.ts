/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  adm-step10-proof-seed — fixtures PUBLIQUES de la preuve Étape 10
 * ─────────────────────────────────────────────────────────────────────────────
 *  (les comptes admin viennent des CLI réels — bootstrap + admin:create, en
 *  amont du runner). Ce script crée : un auteur « Browser Cible » avec un post
 *  signalé (visible dans /queue et bannable en four-eyes), un reporteur, et
 *  quelques posts de bruit pour le fil.
 *
 *  Usage : DATABASE_URL="file:$(pwd)/db/adm-step10-proof.db" bun scripts/adm-step10-proof-seed.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ log: [] });

const existing = await db.user.count();
if (existing > 0) {
  console.log(`seed ignoré — ${existing} users déjà présents (idempotent)`);
  await db.$disconnect();
  process.exit(0);
}

const target = await db.user.create({
  data: { pubkey: "step10-browser-target", nickname: "Browser Cible", bio: "Cible des parcours admin Étape 10." },
});
const reporter = await db.user.create({
  data: { pubkey: "step10-reporter", nickname: "Reporter É10" },
});

const post = await db.post.create({
  data: { authorId: target.id, content: "post signalé — cible four-eyes Étape 10 (contenu litigieux simulé)" },
});
await db.report.create({
  data: { targetKind: "post", targetId: post.id, reason: "preuve Étape 10 — signalé pour le parcours queue", reporterKey: reporter.pubkey },
});

// bruit de fil (la queue pèse par COUNT de reports — la cible doit ressortir)
for (let i = 0; i < 5; i++) {
  const u = await db.user.create({ data: { pubkey: `step10-filler-${i}`, nickname: `Filler ${i}` } });
  await db.post.create({ data: { authorId: u.id, content: `post de remplissage #${i} (Étape 10 — preuve)` } });
}

console.log("seed Étape 10 : 1 cible (post + report), 1 reporteur, 5 fillers");
await db.$disconnect();
