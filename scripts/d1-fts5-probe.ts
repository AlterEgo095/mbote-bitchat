/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D1 — SONDE DE PRÉREQUIS BLOQUANT : FTS5 dans le SQLite embarqué de Prisma
 * ─────────────────────────────────────────────────────────────────────────────
 *  Exécuter AVANT tout code D1 (même discipline que les prérequis C2) :
 *
 *    DATABASE_URL sans importance (DB jetable /tmp) :
 *      bun scripts/d1-fts5-probe.ts
 *
 *  Vérifie : CREATE VIRTUAL TABLE … USING fts5 avec tokenize='unicode61
 *  remove_diacritics 2', le match « ecole » → « école » (diacritiques), le
 *  cas négatif (0 ligne), snippet() et bm25(). Échec = exit 1 → D1 S'ARRÊTE
 *  (plan B documenté : LIKE + normalisation applicative, ~10× plus lent).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { PrismaClient } from "@prisma/client";

interface ProbeRow {
  s: string;
  r: number;
}
interface CountRow {
  c: bigint | number;
}

const db = new PrismaClient({
  datasources: { db: { url: "file:/tmp/fts5-probe.db" } },
});
try {
  await db.$executeRawUnsafe("DROP TABLE IF EXISTS probe_fts");
  await db.$executeRawUnsafe(
    "CREATE VIRTUAL TABLE probe_fts USING fts5(content, tokenize='unicode61 remove_diacritics 2')"
  );
  await db.$executeRawUnsafe(
    `INSERT INTO probe_fts(content) VALUES ('l''école à Kinshasa')`
  );
  const hit = await db.$queryRawUnsafe<ProbeRow[]>(
    "SELECT snippet(probe_fts, 0, '[', ']', '…', 6) AS s, bm25(probe_fts) AS r FROM probe_fts WHERE probe_fts MATCH '\"ecole\"'"
  );
  console.log("FTS5 OK — diacritics match:", JSON.stringify(hit));
  if (!Array.isArray(hit) || hit.length !== 1) {
    throw new Error("match « ecole » → « école » attendu : 1 ligne");
  }
  const miss = await db.$queryRawUnsafe<CountRow[]>(
    "SELECT count(*) AS c FROM probe_fts WHERE probe_fts MATCH '\"banana\"'"
  );
  console.log("negative case rows:", miss[0].c);
  if (miss[0].c !== 0n && miss[0].c !== 0) {
    throw new Error("cas négatif attendu : 0 ligne");
  }
  console.log("VERDICT: FTS5 AVAILABLE");
} catch (e) {
  console.error("VERDICT: FTS5 UNAVAILABLE:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  await db.$disconnect();
}
