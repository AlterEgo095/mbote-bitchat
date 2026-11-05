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
 *        --admin-key "$ADMIN_API_KEY" --execute
 *
 *  Sans `--execute`, la purge est un DRY-RUN (n'affiche que ce qui serait fait).
 *  ADM Étape 0 (rupture) : le CLI est le SEUL consommateur restant d'
 *  `ADMIN_API_KEY` (secret machine) — fournie via `--admin-key`, comparée en
 *  timing-safe à l'env, JAMAIS stockée en DB, JAMAIS renvoyée. L'acteur des
 *  traces est le pseudo-user `system` (seed 0004) avec label "cli".
 *
 *  DATABASE_URL : lu de l'environnement ou de .env (bun le charge).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseArgs } from "util";
import { PrismaClient } from "@prisma/client";
import { auditSnippet, isAdminKey, purgePostWithAudit } from "../src/lib/mbote/moderation";
import { getSystemActor } from "../src/lib/mbote/admin-auth";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    list: { type: "boolean", default: false },
    purge: { type: "string" },
    "min-reports": { type: "string", default: "1" },
    limit: { type: "string", default: "50" },
    reason: { type: "string" },
    "admin-key": { type: "string" },
    execute: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help || (!values.list && !values.purge)) {
  console.log(
    `Usage:
  bun scripts/moderation-purge.ts --list [--min-reports 3] [--limit 50]
  bun scripts/moderation-purge.ts --purge <postId> --reason "..." --admin-key "$ADMIN_API_KEY" --execute

Sans --execute : dry-run (aucune écriture).
--admin-key : requis avec --execute (timing-safe vs ADMIN_API_KEY — jamais stockée, jamais affichée).`
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
    `\nPurge : bun scripts/moderation-purge.ts --purge <postId> --reason "..." --admin-key "$ADMIN_API_KEY" --execute\n`
  );
}

async function purgeOne(): Promise<void> {
  const postId = values.purge as string;
  const providedKey = values["admin-key"] ?? "";
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
      `\nDRY-RUN — purge de ${postId} :\n  auteur=${post.author.nickname} (${post.author.pubkey.slice(0, 12)}…)\n  « ${auditSnippet(post.content, 160)} »\n  likes=${post.likeCount}  signalements ouverts=${openReports}\n  → traces ModerationAction(action=purge, actorLabel="cli") + AdminAudit(actorId=system)\nRelancer avec --execute --admin-key "$ADMIN_API_KEY" pour appliquer.\n`
    );
    return;
  }

  // ADM Étape 0 — la clé est le secret machine du CLI : validée timing-safe,
  // jamais affichée, jamais stockée. Acteur = pseudo-user system (label "cli").
  if (!isAdminKey(providedKey)) {
    console.error("Clé admin invalide (ADMIN_API_KEY) — purge refusée.");
    process.exit(1);
  }
  const system = await getSystemActor();

  try {
    const outcome = await db.$transaction((tx) =>
      purgePostWithAudit(tx, {
        postId,
        actor: {
          adminUserId: system.id,
          actorLabel: "cli",
          actorRole: system.role,
          ip: null,
          userAgent: "cli:moderation-purge",
        },
        reason: values.reason ?? null,
      })
    );
    console.log(
      `\nPURGÉ ${outcome.purgedPostId} — auteur=${outcome.authorNickname} (${outcome.authorKey.slice(0, 12)}…), réponses purgées=${outcome.repliesPurged}, likes=${outcome.likeCount}, signalements clôturés=${outcome.reportsClosed.length}\nTraces : ModerationAction(action=purge, targetId=${outcome.purgedPostId}, actorLabel="cli") + AdminAudit(actorId=${system.id}, actorRole="system")\n`
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
