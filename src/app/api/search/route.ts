import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  clientIp,
  getRateStore,
  trackApiRequest,
} from "@/lib/mbote/state-store";

export const dynamic = "force-dynamic";

// ── D1 — recherche globale du fil public (FTS5) ──────────────────────────────
// PÉRIMÈTRE STRICT (spec D1) : ce endpoint ne touche JAMAIS les DM. Les DM sont
// E2EE (le serveur ne stocke que du ciphertext) et leur recherche est LOCALE
// (IndexedDB, src/lib/mbote/dm-search-index.ts). Toute requête type=dms est
// rejetée 400 — garde-fou explicite de la frontière serveur/DM.
// Rate limit : 30 req/min par IP (search = lecture anonyme possible).

const SEARCH_PER_MIN_PER_IP = 30;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_OFFSET = 980; // 50 pages × 20 — borne documentée (profondeur bornée)
const MAX_TERMS = 8;
const MAX_Q_LENGTH = 200;
const SNIPPET_TOKENS = 12; // ≈ 60 caractères (spec : snippet 60)

/**
 * Construit la requête FTS5 MATCH depuis l'entrée utilisateur — PURE.
 * - termes = uniquement lettres/chiffres Unicode (les opérateurs FTS5 —
 *   NEAR, AND, OR, NOT, ^, :, *, (), "" — sont donc neutralisés) ;
 * - chaque terme est quoté (phrase littérale) → aucune injection de syntaxe ;
 * - jointure par espace = ET implicite (tous les termes requis) ;
 * - max 8 termes (borne de coût de la requête).
 * Retourne null si aucun terme exploitable (→ 400 côté route).
 */
export function toFtsQuery(raw: string): string | null {
  const terms = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms
    .slice(0, MAX_TERMS)
    .map((t) => `"${t}"`)
    .join(" ");
}

interface FtsRow {
  postId: string;
  snippet: string;
  rank: number;
  authorPubkey: string;
  authorNickname: string;
  createdAt: Date;
}

/** GET /api/search?q=&type=posts&limit=20&offset=0
 *  Recherche plein-texte du FIL PUBLIC uniquement (FTS5 PostFTS).
 *  Réponse : { results: [{postId, snippet, rank, authorPubkey, authorNickname,
 *  createdAt}], hasMore, nextOffset }.
 *  `rank` = bm25(PostFTS) — PLUS PETIT = PLUS PERTINENT (convention SQLite).
 */
export async function GET(req: NextRequest) {
  const done = trackApiRequest("search.get");
  try {
    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim();
    const type = sp.get("type") ?? "posts";

    // garde-fou frontière DM : le serveur ne recherche JAMAIS les DM
    if (type !== "posts") {
      return NextResponse.json(
        {
          error:
            "type non supporté — seuls les posts publics sont recherchables côté serveur ; la recherche des messages privés est locale à l'appareil (E2EE)",
        },
        { status: 400 }
      );
    }

    if (!q || q.length > MAX_Q_LENGTH) {
      return NextResponse.json(
        { error: `q requis (${MAX_Q_LENGTH} caractères max)` },
        { status: 400 }
      );
    }

    const ftsQuery = toFtsQuery(q);
    if (!ftsQuery) {
      return NextResponse.json(
        { error: "q ne contient aucun terme recherchable" },
        { status: 400 }
      );
    }

    // ── rate limit (30 req/min par IP) ──
    const rates = getRateStore();
    const ip = clientIp(req.headers);
    const byIp = rates.hit(`search-ip:${ip}`, SEARCH_PER_MIN_PER_IP, RATE_WINDOW_MS);
    if (!byIp.allowed) {
      const retry = Math.ceil(byIp.retryAfterMs / 1000);
      return NextResponse.json(
        { error: "Trop de recherches — ralentissez" },
        { status: 429, headers: { "Retry-After": String(retry || 60) } }
      );
    }

    const limitRaw = sp.get("limit");
    const parsedLimit = limitRaw == null ? DEFAULT_LIMIT : Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
      return NextResponse.json(
        { error: `limit invalide (1..${MAX_LIMIT})` },
        { status: 400 }
      );
    }
    const offsetRaw = sp.get("offset");
    const parsedOffset = offsetRaw == null ? 0 : Number(offsetRaw);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > MAX_OFFSET) {
      return NextResponse.json(
        { error: `offset invalide (0..${MAX_OFFSET})` },
        { status: 400 }
      );
    }

    // $queryRaw (tagged template) = paramètres BOUND par Prisma — aucune
    // interpolation de chaîne ; les identifiants (PostFTS, colonnes) sont
    // STATIQUES. Le filtre auteur (suspension temporaire + ban) reproduit
    // EXACTEMENT le where du fil public (route.ts posts GET) — cf. migration
    // 0009 : la visibilité AUTEUR est réversible → filtrée à la lecture.
    // limit+1 pour calculer hasMore sans COUNT(*) supplémentaire.
    const now = new Date();
    const rows = await db.$queryRaw<FtsRow[]>`
      SELECT
        p.id            AS postId,
        snippet(PostFTS, 0, '', '', '…', ${SNIPPET_TOKENS}) AS snippet,
        bm25(PostFTS)   AS rank,
        u.pubkey        AS authorPubkey,
        u.nickname      AS authorNickname,
        p.createdAt     AS createdAt
      FROM PostFTS
      JOIN Post p ON p.id = PostFTS.postId
      JOIN User u ON u.id = p.authorId
      WHERE PostFTS MATCH ${ftsQuery}
        AND p.hiddenAt IS NULL
        AND (u.suspendedAt IS NULL OR u.suspendedUntil < ${now})
        AND u.bannedAt IS NULL
      ORDER BY rank
      LIMIT ${parsedLimit + 1}
      OFFSET ${parsedOffset}
    `;

    // Clarification 1 — le résultat d'une requête brute est VALIDÉ, jamais
    // supposé : $queryRaw doit rendre un tableau (sinon = couche transport
    // inattendue → 500 loud plutôt que réponse silencieusement vide).
    if (!Array.isArray(rows)) {
      throw new Error(
        "[search] $queryRaw a retourné un résultat non-tabulaire — refus de servir une réponse vide en silence"
      );
    }

    const hasMore = rows.length > parsedLimit;
    const page = rows.slice(0, parsedLimit);

    return NextResponse.json({
      query: q,
      ftsQuery,
      results: page.map((r) => ({
        postId: r.postId,
        // cap dur à ~60 caractères utiles (snippet FTS5 compte des tokens)
        snippet: r.snippet.length > 64 ? r.snippet.slice(0, 64) + "…" : r.snippet,
        rank: r.rank,
        authorPubkey: r.authorPubkey,
        authorNickname: r.authorNickname,
        createdAt: r.createdAt,
      })),
      hasMore,
      nextOffset: hasMore ? parsedOffset + parsedLimit : null,
    });
  } catch (e) {
    console.error("GET /api/search", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
