/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  moderation-purge — tooling d'exploitation A3 (purge du fil public)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Outil CLI admin qui complète POST /api/moderation/action : purge directe en
 *  DB avec LA MÊME trace d'audit (helper partagé `purgePostWithAudit` — un seul
 *  comportement d'audit pour l'API et le CLI).
 *
 *  Usage :
 *    bun scripts/moderation-purge.ts --list [--min-reports 3] [--limit 50]
 *    bun scripts/moderation-purge.ts --purge <postId> --reason "..." \
 *        --admin-label "ops:cli-alice" --execute
 *
 *  Sans `--execute`, la purge est un DRY-RUN (n'affiche que ce qui serait fait).
 *  La trace `ModerationAction` est écrite avec `adminKey = --admin-label`
 *  (chaîne libre d'exploitation — l'outil opère en DB, il est par nature admin ;
 *  le label laisse une piste humaine dans l'audit).
 *
 *  DATABASE_URL : lu de l'environnement ou de .env (bun le charge).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseArgs } from "util";
import { PrismaClient } from "@prisma/client";
import { auditSnippet, purgePostWithAudit } from "../src/lib/mbote/moderation";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    list: { type: "boolean", default: false },
    purge: { type: "string" },
    "min-reports": { type: "string", default: "1" },
    limit: { type: "string", default: "50" },
    reason: { type: "string" },
    "admin-label": { type: "string" },
    execute: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help || (!values.list && !values.purge)) {
  console.log(
    `Usage:
  bun scripts/moderation-purge.ts --list [--min-reports 3] [--limit 50]
  bun scripts/moderation-purge.ts --purge <postId> --reason "..." --admin-label "ops:cli" --execute

Sans --execute : dry-run (aucune écriture).`
  );
  process.exit(values.help ? 0 : 1);
}

const db = new PrismaClient();

async function listCandidates(): Promise<void> {
  const minReports = Math.max(1, Number(values["min-reports"] ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(values.limit ?? 50) || 50));

  const grouped = await db.report.groupBy({
    by: ["targetId"],
    where: { status: "open", targetKind: { in: ["post", "comment"] } },
    _count: { _all: true },
    having: { targetId: { _count: { gte: minReports } } } as never,
    orderBy: { _count: { targetId: "desc" } },
  });

  const ids = grouped.map((g) => g.targetId).slice(0, limit);
  if (ids.length === 0) {
    console.log(`Aucune cible avec ≥ ${minReports} signalement(s) ouvert(s).`);
    return;
  }

  const posts = await db.post.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      content: true,
      hiddenAt: true,
      createdAt: true,
      author: { select: { pubkey: true, nickname: true, suspendedAt: true } },
    },
  });
  const countByTarget = new Map(grouped.map((g) => [g.targetId, g._count._all]));

  console.log(`\nCibles candidates (≥ ${minReports} signalement(s) ouvert(s)) :\n`);
  for (const p of posts) {
    console.log(
      `  • ${p.id}  reports=${countByTarget.get(p.id) ?? 0}  hidden=${p.hiddenAt ? "oui" : "non"}  auteur=${p.author.nickname} (${p.author.pubkey.slice(0, 12)}…)  suspendu=${p.author.suspendedAt ? "oui" : "non"}\n    « ${auditSnippet(p.content, 120)} »`
    );
  }
  console.log(
    `\nPurge : bun scripts/moderation-purge.ts --purge <postId> --reason "..." --admin-label "ops:cli" --execute\n`
  );
}

async function purgeOne(): Promise<void> {
  const postId = values.purge as string;
  const adminLabel = values["admin-label"] ?? "ops:cli";
  if (!values.execute) {
    const post = await db.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        content: true,
        likeCount: true,
        author: { select: { pubkey: true, nickname: true } },
      },
    });
    if (!post) {
      console.error(`Post ${postId} introuvable (ou déjà purgé).`);
      process.exit(1);
    }
    const openReports = await db.report.count({
      where: { targetId: postId, status: "open" },
    });
    console.log(
      `\nDRY-RUN — purge de ${postId} :\n  auteur=${post.author.nickname} (${post.author.pubkey.slice(0, 12)}…)\n  « ${auditSnippet(post.content, 160)} »\n  likes=${post.likeCount}  signalements ouverts=${openReports}\n  → trace ModerationAction(action=purge, adminKey=${adminLabel})\nRelancer avec --execute pour appliquer.\n`
    );
    return;
  }

  try {
    const outcome = await db.$transaction((tx) =>
      purgePostWithAudit(tx, {
        postId,
        adminKey: adminLabel,
        reason: values.reason ?? null,
      })
    );
    console.log(
      `\nPURGÉ ${outcome.purgedPostId} — auteur=${outcome.authorNickname} (${outcome.authorKey.slice(0, 12)}…), réponses purgées=${outcome.repliesPurged}, likes=${outcome.likeCount}, signalements clôturés=${outcome.reportsClosed.length}\nTrace : ModerationAction(action=purge, targetId=${outcome.purgedPostId}, adminKey=${adminLabel})\n`
    );
  } catch (err) {
    if (err instanceof Error && err.message === "POST_NOT_FOUND") {
      console.error(`Post ${postId} introuvable (ou déjà purgé).`);
      process.exit(1);
    }
    throw err;
  }
}

try {
  if (values.list) await listCandidates();
  else if (values.purge) await purgeOne();
} finally {
  await db.$disconnect();
}
