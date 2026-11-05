/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  HARNESS A3 — modération du fil public (unitaire + persistance)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Scénarios :
 *    U1. clé admin : absente de l'env → tout refusé ; mauvaise clé → refusé ;
 *        bonne clé → accepté (comparaison timing-safe, 403 uniforme côté API)
 *    U2. auditSnippet : extrait borné ≤ 280 (purge → le contenu disparaît,
 *        l'extrait d'audit reste)
 *    U3. purge transactionnelle : post supprimé (cascade réponses + likes),
 *        trace ModerationAction avec auteur/extrait/compteurs, signalements
 *        clôturés, compteur du parent décrémenté
 *    U4. idempotence du signalement : @@unique(reporter, targetKind, targetId)
 *        → P2002 (un même signaleur ne gonfle pas la file)
 *
 *  Commande : bun test tests/moderation.test.ts   (SQLite fichier temporaire)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PrismaClient, Prisma } from "@prisma/client";
import { auditSnippet, isAdminKey, purgePostWithAudit } from "../src/lib/mbote/moderation";

function fakeKey(seed: number): string {
  const bytes = new Uint8Array(65);
  bytes[0] = 0x04;
  for (let i = 1; i < 65; i++) bytes[i] = (seed * 31 + i * 7) % 256;
  return Buffer.from(bytes).toString("base64url");
}

let dir: string;
let db: PrismaClient;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mbote-a3-"));
  const url = `file:${join(dir, "moderation.db")}`;
  execSync(`bunx prisma db push --skip-generate`, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url } } });
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("A3 — garde admin (clé API provisoire)", () => {
  test("U1a · ADMIN_API_KEY absente → aucun accès admin", () => {
    const prev = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
      expect(isAdminKey("a3-dev-admin-key")).toBeFalse();
      expect(isAdminKey(null)).toBeFalse();
      expect(isAdminKey(undefined)).toBeFalse();
    } finally {
      if (prev !== undefined) process.env.ADMIN_API_KEY = prev;
    }
  });

  test("U1b · mauvaise clé → refusé · bonne clé → accepté", () => {
    process.env.ADMIN_API_KEY = "a3-dev-admin-key";
    try {
      expect(isAdminKey("mauvaise-clé")).toBeFalse();
      expect(isAdminKey("")).toBeFalse();
      expect(isAdminKey("a3-dev-admin-key")).toBeTrue();
    } finally {
      delete process.env.ADMIN_API_KEY;
    }
  });
});

describe("A3 — extrait d'audit borné", () => {
  test("U2 · contenu court inchangé · contenu long tronqué ≤ 280", () => {
    expect(auditSnippet("court")).toBe("court");
    const long = "x".repeat(1000);
    const snip = auditSnippet(long);
    expect(snip.length).toBeLessThanOrEqual(280);
    expect(snip.endsWith("…")).toBeTrue();
    expect(snip.startsWith("xxx")).toBeTrue();
  });
});

describe("A3 — purge transactionnelle avec trace d'audit", () => {
  test("U3 · post supprimé (cascade), trace conservée, reports clôturés, compteur parent", async () => {
    const author = await db.user.create({
      data: { pubkey: fakeKey(11), nickname: "U3-auteur" },
    });
    const parent = await db.post.create({
      data: { authorId: author.id, content: "post racine U3" },
    });
    const reply = await db.post.create({
      data: { authorId: author.id, content: "réponse U3 (la cible de purge)", parentId: parent.id },
    });
    await db.like.create({ data: { postId: reply.id, userId: author.id } });
    await db.post.update({ where: { id: parent.id }, data: { replyCount: 1 } });

    const r1 = await db.report.create({
      data: { reporterKey: fakeKey(12), targetKind: "comment", targetId: reply.id, reason: "spam" },
    });
    const r2 = await db.report.create({
      data: { reporterKey: fakeKey(13), targetKind: "comment", targetId: reply.id, reason: "harassment" },
    });

    const outcome = await db.$transaction((tx) =>
      purgePostWithAudit(tx, { postId: reply.id, adminKey: "test:u3", reason: "test U3" })
    );

    expect(outcome.purgedPostId).toBe(reply.id);
    expect(outcome.authorKey).toBe(author.pubkey);
    expect(outcome.snippet).toContain("réponse U3");
    expect(outcome.repliesPurged).toBe(0);
    expect(outcome.reportsClosed.sort()).toEqual([r1.id, r2.id].sort());

    // le post purgé N'EXISTE PLUS en DB (exigence purge), le parent oui
    expect(await db.post.findUnique({ where: { id: reply.id } })).toBeNull();
    expect(await db.post.findUnique({ where: { id: parent.id } })).not.toBeNull();
    // cascade : le like du post purgé est parti
    expect(await db.like.findFirst({ where: { postId: reply.id } })).toBeNull();
    // compteur dénormalisé du parent décrémenté
    expect((await db.post.findUnique({ where: { id: parent.id } }))?.replyCount).toBe(0);
    // signalements clôturés
    const closed = await db.report.findMany({ where: { targetId: reply.id } });
    expect(closed.every((r) => r.status === "actioned" && r.handledBy === "test:u3")).toBeTrue();
    // TRACE D'AUDIT CONSERVÉE (exigence : le contenu disparaît, la trace reste)
    const traces = await db.moderationAction.findMany({ where: { targetId: reply.id } });
    expect(traces.length).toBe(1);
    const trace = traces[0];
    expect(trace.action).toBe("purge");
    expect(trace.adminKey).toBe("test:u3");
    const meta = JSON.parse(trace.meta ?? "{}") as Record<string, unknown>;
    expect(meta.authorKey).toBe(author.pubkey);
    expect(meta.nickname).toBe("U3-auteur");
    expect(meta.closedReports).toBe(2);
    expect(String(meta.snippet)).toContain("réponse U3");
    expect(JSON.parse(trace.reportIds ?? "[]")).toEqual(expect.arrayContaining([r1.id, r2.id]));
  });

  test("U3b · purge d'un post déjà purgé → POST_NOT_FOUND (pas de double trace)", async () => {
    await expect(
      db.$transaction((tx) => purgePostWithAudit(tx, { postId: "inexistant", adminKey: "test:u3b" }))
    ).rejects.toThrow("POST_NOT_FOUND");
    expect(await db.moderationAction.count({ where: { targetId: "inexistant" } })).toBe(0);
  });
});

describe("A3 — idempotence du signalement", () => {
  test("U4 · un même signaleur ne peut pas gonfler la file sur une cible (P2002)", async () => {
    const author = await db.user.create({
      data: { pubkey: fakeKey(21), nickname: "U4-auteur" },
    });
    const post = await db.post.create({
      data: { authorId: author.id, content: "post U4" },
    });
    const reporter = fakeKey(22);
    await db.report.create({
      data: { reporterKey: reporter, targetKind: "post", targetId: post.id, reason: "spam" },
    });
    let code: string | undefined;
    try {
      await db.report.create({
        data: { reporterKey: reporter, targetKind: "post", targetId: post.id, reason: "other" },
      });
    } catch (e) {
      code = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : undefined;
    }
    expect(code).toBe("P2002");
    expect(await db.report.count({ where: { targetId: post.id } })).toBe(1);
  });
});
