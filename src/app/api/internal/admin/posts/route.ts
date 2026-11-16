import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/posts — annuaire GLOBAL des contenus publics
 *  (back-office 2026-11 : « l'admin voit tout le fil public »)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Périmètre : posts publics + commentaires (les deux sont des lignes `Post`,
 *  contenu serveur-visible par DÉFINITION — le fil est public). AUCUN contenu
 *  DM / groupe : E2EE par conception (invariant §1.4 ADMIN-RBAC.md) — le
 *  panneau ne voit que ce que le serveur voit, jamais plus.
 *
 *  Différence avec la queue (Étape 6) : la queue liste les SIGNALEMENTS ;
 *  ici c'est l'ANNUAIRE EXHAUSTIF des contenus (signalés ou non, masqués ou
 *  non) — l'admin peut naviguer et agir hors d'un report (hide direct avec
 *  justification §6 via /api/moderation/action, purge via four-eyes É9).
 *
 *  AUTH : requireAdmin({minRole:"support"}) — même arbitrage §13.1 que
 *  l'annuaire users (lecture) ; l'auditor reste STRICT (403).
 *
 *  MODE RECHERCHE : q présent → LIKE sur content (limite 20, pas de cursor).
 *  MODE LISTE : cursor keyset 20/page, tri createdAt DESC + id DESC (id en
 *  tiebreak — les posts créés dans la même ms restent ordonnés).
 *
 *  FILTRES :
 *   - status : all | visible (hiddenAt IS NULL) | hidden (masqué) | reported
 *     (≥ 1 report ouvert — EXISTS, évalué à l'instant de la requête) ;
 *   - kind : all | post (racine, parentId IS NULL) | comment (réponse) ;
 *   - period : 24h | 7d | 30d | all ;
 *   - author : pubkey exacte (ex. depuis la fiche utilisateur).
 *
 *  CURSOR OPAQUE : base64url JSON {k:"posts", c, i} — la garde de vue (k ≠
 *  "posts" → 400) empêche de rejouer un curseur d'un autre annuaire ; ancre
 *  disparue / ne satisfaisant plus les filtres → RESTART page 1 +
 *  `cursorReset: true` (même sémantique users/queue). PAGINATION APPROXIMATIVE
 *  SOUS MUTATION CONFORTE (documenté, ADM-step6 §5) : un contenu peut être
 *  masqué/purgé entre deux pages — le keyset est exact sur l'instantané.
 *
 *  DONNÉES : l'endpoint renvoie le content COMPLET des 20 lignes de la page
 *  (l'admin a le droit de tout voir du public — le client borne l'affichage à
 *  un snippet dans la liste ; le détail /posts/[id] l'affiche intégré).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PAGE_SIZE = 20;
const SEARCH_LIMIT = 20;

const PERIODS: Record<string, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

interface PostsCursor {
  k: "posts";
  c: number; // createdAt de l'ancre (epoch ms)
  i: string; // id de l'ancre
}

function decodeCursor(raw: string | null): PostsCursor | null | "malformed" {
  if (raw === null) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      json.k !== "posts" ||
      typeof json.c !== "number" || !Number.isInteger(json.c) || json.c <= 0 ||
      typeof json.i !== "string" || json.i.length === 0 || json.i.length > 128
    ) {
      return "malformed";
    }
    return { k: "posts", c: json.c, i: json.i };
  } catch {
    return "malformed";
  }
}

function encodeCursor(c: PostsCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Échappe LIKE (%, _, \) — la recherche est un LIKE, pas une regex. */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Liste blanche des filtres statut. */
const STATUS_FILTERS = ["all", "visible", "hidden", "reported"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.posts");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const status = sp.get("status") ?? "all";
    const kind = sp.get("kind") ?? "all";
    const period = sp.get("period") ?? "all";
    const author = sp.get("author");

    if (!(STATUS_FILTERS as readonly string[]).includes(status)) {
      return NextResponse.json(
        { error: "status invalide (all | visible | hidden | reported)" },
        { status: 400 }
      );
    }
    if (!["all", "post", "comment"].includes(kind)) {
      return NextResponse.json(
        { error: "kind invalide (post | comment | all)" },
        { status: 400 }
      );
    }
    if (!(period === "all" || period in PERIODS)) {
      return NextResponse.json(
        { error: "period invalide (24h | 7d | 30d | all)" },
        { status: 400 }
      );
    }
    if (author !== null && (author.length === 0 || author.length > 200)) {
      return NextResponse.json({ error: "author invalide (pubkey 1..200 caractères)" }, { status: 400 });
    }
    const q = sp.get("q");
    if (q !== null && q.trim().length === 0) {
      return NextResponse.json({ error: "q vide (omettre le paramètre pour lister)" }, { status: 400 });
    }

    // ── conditions de BASE (partagées : recherche, liste, ancre du curseur) ──
    const baseParams: (string | number)[] = [];
    const statusConds: string[] = [];
    switch (status as StatusFilter) {
      case "visible":
        statusConds.push("p.hiddenAt IS NULL");
        break;
      case "hidden":
        statusConds.push("p.hiddenAt IS NOT NULL");
        break;
      case "reported":
        statusConds.push(
          `EXISTS (SELECT 1 FROM Report rr WHERE rr.status = 'open'
                     AND rr.targetKind IN ('post', 'comment') AND rr.targetId = p.id)`
        );
        break;
      default:
        break; // all
    }
    const kindCond = kind === "post" ? "AND p.parentId IS NULL" : kind === "comment" ? "AND p.parentId IS NOT NULL" : "";
    const sinceMs = period === "all" ? 0 : Date.now() - PERIODS[period];
    const periodCond = sinceMs > 0 ? "AND p.createdAt >= ?" : "";
    if (sinceMs > 0) baseParams.push(sinceMs);
    const authorCond = author ? "AND u.pubkey = ?" : "";
    if (author) baseParams.push(author);

    const baseWhere =
      statusConds.length > 0
        ? `WHERE ${statusConds.join(" AND ")} ${kindCond} ${periodCond} ${authorCond}`
        : `WHERE 1=1 ${kindCond} ${periodCond} ${authorCond}`;

    const SELECT_COLS = `p.id, p.content, p.createdAt, p.origin, p.geohash, p.likeCount, p.replyCount,
         p.parentId, p.hiddenAt, u.pubkey AS authorPubkey, u.nickname AS authorNickname,
         (SELECT COUNT(*) FROM Report r WHERE r.status = 'open'
            AND r.targetKind IN ('post', 'comment') AND r.targetId = p.id) AS openReports`;

    // ── MODE RECHERCHE : q présent → LIKE content, limite 20, PAS de cursor ──
    if (q !== null) {
      const needle = `%${escapeLike(q.trim())}%`;
      const rows = await db.$queryRawUnsafe<Array<RawPostRow>>(
        `SELECT ${SELECT_COLS}
         FROM Post p
         JOIN User u ON u.id = p.authorId
         ${baseWhere}
           AND p.content LIKE ? ESCAPE '\\'
         ORDER BY p.createdAt DESC, p.id DESC
         LIMIT ${SEARCH_LIMIT}`,
        ...baseParams,
        needle
      );
      return NextResponse.json({
        mode: "search",
        items: rows.map(mapItem),
        total: rows.length,
        page: { size: SEARCH_LIMIT, status, kind, period, author: author ?? null, q: q.trim() },
      });
    }

    // ── MODE LISTE : cursor keyset (20/page) ────────────────────────────────
    const cursorOr = decodeCursor(sp.get("cursor"));
    if (cursorOr === "malformed") {
      return NextResponse.json({ error: "cursor invalide" }, { status: 400 });
    }
    if (cursorOr && cursorOr.k !== "posts") {
      return NextResponse.json(
        { error: "cursor invalide (émis sous un autre annuaire — repartez de la page 1)" },
        { status: 400 }
      );
    }

    // ancre : disparue (purgée) ou ne satisfaisant plus les filtres → restart
    let cursor: PostsCursor | null = cursorOr;
    let cursorReset = false;
    if (cursor) {
      const anchor = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n
         FROM Post p
         JOIN User u ON u.id = p.authorId
         ${baseWhere} AND p.id = ?`,
        ...baseParams,
        cursor.i
      );
      if (Number(anchor[0]?.n ?? 0) === 0) {
        cursor = null;
        cursorReset = true;
      }
    }

    const keysetCond = cursor
      ? `WHERE (t.createdAt < ? OR (t.createdAt = ? AND t.id < ?))`
      : "";
    const keysetParams: (string | number)[] = cursor
      ? [cursor.c, cursor.c, cursor.i]
      : [];

    const rows = await db.$queryRawUnsafe<Array<RawPostRow>>(
      `SELECT * FROM (
         SELECT ${SELECT_COLS}
         FROM Post p
         JOIN User u ON u.id = p.authorId
         ${baseWhere}
       ) t
       ${keysetCond}
       ORDER BY t.createdAt DESC, t.id DESC
       LIMIT ${PAGE_SIZE + 1}`,
      ...baseParams,
      ...keysetParams
    );

    const hasNext = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const nextCursor =
      hasNext && last
        ? encodeCursor({ k: "posts", c: new Date(last.createdAt).getTime(), i: last.id })
        : null;

    return NextResponse.json({
      mode: "list",
      items: page.map(mapItem),
      nextCursor,
      cursorReset,
      page: { size: PAGE_SIZE, status, kind, period, author: author ?? null },
    });
  } catch (e) {
    console.error("GET /api/internal/admin/posts", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

interface RawPostRow {
  id: string; content: string; createdAt: Date; origin: string; geohash: string | null;
  likeCount: number; replyCount: number; parentId: string | null; hiddenAt: Date | null;
  authorPubkey: string; authorNickname: string; openReports: number;
}

function mapItem(r: RawPostRow) {
  return {
    id: r.id,
    content: r.content,
    createdAt: r.createdAt,
    origin: r.origin,
    geohash: r.geohash,
    likeCount: Number(r.likeCount),
    replyCount: Number(r.replyCount),
    parentId: r.parentId,
    isReply: r.parentId !== null,
    hiddenAt: r.hiddenAt,
    authorPubkey: r.authorPubkey,
    authorNickname: r.authorNickname,
    openReports: Number(r.openReports),
  };
}
