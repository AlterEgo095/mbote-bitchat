/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D1 — RECHERCHE : suite de preuve contre le serveur RÉEL (build prod)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Commande (orchestrée par scripts/d1-search-proof-run.sh) :
 *    D1_SEARCH_BASE_URL="http://127.0.0.1:3163" \
 *    D1_SEARCH_DB="file:$ROOT/db/d1-search-proof.db" \
 *    bun test tests/d1-search.test.ts
 *  (garde module-level → SKIP propre en suite globale — pattern É5/É6/É7/É10)
 *
 *  Scénarios (directive D1) :
 *   T1. FTS5 hit : post « Kinshasa » → trouvé, payload complet (postId,
 *       snippet ≤ 65 car., rank bm25, authorPubkey, authorNickname).
 *   T2. Diacritiques : « ecole » (sans accent) → « école » (unicode61
 *       remove_diacritics 2).
 *   T3. FRONTIÈRE DM : un DM au ciphertext CONTENANT littéralement « secret »
 *       (seed) → q=secret&type=posts → 0 résultat ; type=dms → 400 explicite.
 *       Le serveur ne touche JAMAIS la recherche des DM (E2EE).
 *   T4. TRIGGER hide : hiddenAt posé en DB → post retiré de PostFTS (trigger)
 *       → introuvable via l'API ET absent de l'index (SELECT count).
 *   T5. TRIGGER delete : post supprimé → retiré de l'index → introuvable.
 *   T6. Auteur suspendu : post DANS l'index (suspension réversible) mais
 *       introuvable via l'API — filtre lecture, même sémantique que le fil.
 *   T7. PAGINATION : limit=2 → hasMore+nextOffset ; offset page 2 DISTINCTE ;
 *       dernière page hasMore=false.
 *   T8. BENCHMARK (directive : 10k posts < 200 ms) : 5 mesures directes FTS
 *       (MATCH + JOIN + snippet + bm25, ORDER BY rank LIMIT 20) + 1 aller-
 *       retour HTTP. Budget strict : moyenne < 200 ms.
 *   T9. RATE LIMIT : 30 req/min/IP — exécuté EN DERNIER : consomme le reste du
 *       bucket (compté par le harnais) puis la requête suivante → 429 avec
 *       Retry-After.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect, afterAll } from "bun:test";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.D1_SEARCH_BASE_URL;
const DB_URL = process.env.D1_SEARCH_DB;

const ALICE = "d1-seed-alice-pubkey";

async function searchApi(q: string, extra = ""): Promise<Response> {
  return fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}${extra}`);
}

// compteur de requêtes /api/search consommées (bucket rate-limit partagé —
// tout le harnais passe par la même IP « local » hors production)
let searchCount = 0;
async function searchCounted(q: string, extra = ""): Promise<Response> {
  searchCount += 1;
  return searchApi(q, extra);
}

interface SearchResultJson {
  query: string;
  ftsQuery: string;
  results: Array<{
    postId: string;
    snippet: string;
    rank: number;
    authorPubkey: string;
    authorNickname: string;
    createdAt: string;
  }>;
  hasMore: boolean;
  nextOffset: number | null;
}

const db = new PrismaClient({
  datasources: { db: { url: DB_URL ?? "file:./db/unused-d1.db" } },
  log: [],
});

async function ftsCount(word: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT count(*) AS c FROM PostFTS WHERE PostFTS MATCH '"${word}"'`
  );
  return Number(rows[0].c);
}

describe.skipIf(!BASE || !DB_URL)("D1 recherche serveur (FTS5)", () => {
  test("T1 — hit FTS5 : payload complet (postId, snippet, rank, authorPubkey)", async () => {
    const res = await searchCounted("kinshasa");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SearchResultJson;
    expect(json.ftsQuery).toBe('"kinshasa"');
    expect(json.results.length).toBeGreaterThanOrEqual(1);
    const hit = json.results[0];
    expect(hit.postId).toBeTruthy();
    expect(hit.authorPubkey).toBe(ALICE);
    expect(hit.authorNickname).toContain("Alice");
    expect(typeof hit.rank).toBe("number");
    // snippet borné (cap serveur ≈ 60 car. + marge ellipsis)
    expect(hit.snippet.length).toBeLessThanOrEqual(65);
    expect(hit.snippet.length).toBeGreaterThan(0);
    expect(json.hasMore).toBe(false);
    expect(json.nextOffset).toBeNull();
  });

  test("T2 — diacritiques : « ecole » trouve « école » (remove_diacritics 2)", async () => {
    const res = await searchCounted("ecole");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SearchResultJson;
    expect(json.results.length).toBeGreaterThanOrEqual(1);
    // le post seedé contient « école » — son snippet doit resurgir
    const withEcole = json.results.find((r) => r.snippet.toLowerCase().includes("cole"));
    expect(withEcole).toBeTruthy();
  });

  test("T3 — FRONTIÈRE DM : ciphertext piégé « secret » jamais retourné ; type=dms → 400", async () => {
    // sanity : le piège est bien en DB (un LIKE naïf le trouverait)
    const trap = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT count(*) AS c FROM DirectMessage WHERE ciphertext LIKE '%secret%'`
    );
    expect(Number(trap[0].c)).toBe(1);
    // la recherche serveur ne retourne RIEN pour « secret »
    const res = await searchCounted("secret");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SearchResultJson;
    expect(json.results.length).toBe(0);
    // et la frontière est explicite : demander les DM au serveur → 400
    const bad = await searchApi("secret", "&type=dms");
    expect(bad.status).toBe(400);
    const badJson = (await bad.json()) as { error?: string };
    expect(badJson.error ?? "").toMatch(/locale|E2EE|appareil/i);
  });

  test("T4 — TRIGGER hide : hiddenAt → post retiré de PostFTS et introuvable", async () => {
    const res0 = await searchCounted("motif-cache");
    expect(res0.status).toBe(200);
    const j0 = (await res0.json()) as SearchResultJson;
    expect(j0.results.length).toBe(1); // visible avant hide
    const postId = j0.results[0].postId;
    expect(await ftsCount("motif-cache")).toBe(1);

    // modération A3 : masquage (le MÊME chemin que l'action admin)
    await db.post.update({ where: { id: postId }, data: { hiddenAt: new Date() } });

    const res1 = await searchCounted("motif-cache");
    const j1 = (await res1.json()) as SearchResultJson;
    expect(j1.results.length).toBe(0); // introuvable via l'API
    expect(await ftsCount("motif-cache")).toBe(0); // RETIRÉ de l'index inversé
  });

  test("T5 — TRIGGER delete : post supprimé → retiré de l'index", async () => {
    expect(await ftsCount("motif-supprime")).toBe(1);
    await db.post.deleteMany({ where: { content: { contains: "motif-supprime" } } });
    expect(await ftsCount("motif-supprime")).toBe(0);
    const res = await searchCounted("motif-supprime");
    const json = (await res.json()) as SearchResultJson;
    expect(json.results.length).toBe(0);
  });

  test("T6 — auteur suspendu : dans l'INDEX mais introuvable via l'API (filtre lecture)", async () => {
    // la suspension est réversible → pas retirée de l'index (migration 0009 §modèle)
    expect(await ftsCount("motif-suspendu")).toBe(1);
    const res = await searchCounted("motif-suspendu");
    const json = (await res.json()) as SearchResultJson;
    expect(json.results.length).toBe(0); // même sémantique que le fil public
  });

  test("T7 — pagination : limit=2 → nextOffset ; page 2 DISTINCTE ; fin de liste", async () => {
    const p1 = await searchCounted("paginword", "&limit=2");
    const j1 = (await p1.json()) as SearchResultJson;
    expect(j1.results.length).toBe(2);
    expect(j1.hasMore).toBe(true);
    expect(j1.nextOffset).toBe(2);
    const p2 = await searchCounted("paginword", "&limit=2&offset=2");
    const j2 = (await p2.json()) as SearchResultJson;
    expect(j2.results.length).toBe(2);
    const ids1 = new Set(j1.results.map((r) => r.postId));
    for (const r of j2.results) expect(ids1.has(r.postId)).toBe(false); // DISTINCTE
    const p3 = await searchCounted("paginword", "&limit=2&offset=4");
    const j3 = (await p3.json()) as SearchResultJson;
    expect(j3.results.length).toBe(1);
    expect(j3.hasMore).toBe(false);
    expect(j3.nextOffset).toBeNull();
  });

  test("T8 — BENCHMARK : 10k posts, recherche FTS < 200 ms (moyenne 5 runs)", async () => {
    const n = await db.post.count();
    expect(n).toBeGreaterThanOrEqual(10_000);

    // 5 mesures DIRECTES (même SQL que la route : MATCH + JOIN + snippet + bm25)
    const now = new Date();
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      // $queryRaw (tagged template) — paramètres bound, identique à la route
      const rows = await db.$queryRaw<unknown[]>`
        SELECT p.id AS postId,
               snippet(PostFTS, 0, '', '', '…', 12) AS snippet,
               bm25(PostFTS) AS rank,
               u.pubkey AS authorPubkey, u.nickname AS authorNickname,
               p.createdAt AS createdAt
        FROM PostFTS
        JOIN Post p ON p.id = PostFTS.postId
        JOIN User u ON u.id = p.authorId
        WHERE PostFTS MATCH ${'"bwbench"'}
          AND p.hiddenAt IS NULL
          AND (u.suspendedAt IS NULL OR u.suspendedUntil < ${now})
          AND u.bannedAt IS NULL
        ORDER BY rank
        LIMIT 21 OFFSET 0`;
      const ms = performance.now() - t0;
      timings.push(ms);
      expect(rows.length).toBe(21); // 20 + 1 (hasMore)
    }
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const max = Math.max(...timings);
    console.log(
      `[benchmark FTS 10k] runs=${timings.map((t) => t.toFixed(1)).join(", ")} ms — avg=${avg.toFixed(1)} ms max=${max.toFixed(1)} ms`
    );
    expect(avg).toBeLessThan(200); // directive D1 : < 200 ms sur 10k posts

    // 1 aller-retour HTTP complet (rate limit compté dans le bucket commun)
    const t0 = performance.now();
    const res = await searchCounted("bwbench", "&limit=20");
    const httpMs = performance.now() - t0;
    const json = (await res.json()) as SearchResultJson;
    console.log(`[benchmark HTTP] round-trip=${httpMs.toFixed(1)} ms`);
    expect(res.status).toBe(200);
    expect(json.results.length).toBe(20);
    expect(json.hasMore).toBe(true);
    expect(httpMs).toBeLessThan(1000); // généreux : inclut HTTP + JSON 20 snippets
  });

  test("T9 — rate limit 30 req/min : le reste du bucket passe, la suivante → 429", async () => {
    const remaining = 30 - searchCount; // le harnais a déjà consommé searchCount
    expect(remaining).toBeGreaterThan(5); // sanity : le harnais n'a pas trop bu
    for (let i = 0; i < remaining; i++) {
      const res = await searchCounted("ratelimit-sonde");
      expect(res.status).toBe(200);
    }
    // bucket épuisé : la requête suivante est refusée
    const res = await searchCounted("ratelimit-sonde");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const json = (await res.json()) as { error?: string };
    expect(json.error ?? "").toMatch(/trop de recherches/i);
  });

  afterAll(async () => {
    await db.$disconnect();
  });
});
