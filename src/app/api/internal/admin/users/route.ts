import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/users — annuaire paginé (ADM Étape 7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 7 : page /users du panneau — recherche par pseudo (LIKE,
 *  limite 20), liste paginée CURSOR (20/page), tri (inscription | reports),
 *  filtres (statut, période d'inscription). Colonnes : pseudo, date
 *  d'inscription, nombre de posts, nombre de reports reçus, statut.
 *
 *  AUTH (directive) : requireAdmin({minRole:"support"}) — l'auditor RESTE
 *  strict (lecture seule AdminAudit, arbitrage §12.17) → 403 ici. La matrice
 *  §4 v1.0 disait users.view=auditor : RE-TRANCHÉE sous arbitrage §13.1
 *  (directive Étape 7 explicite : « support » pour la lecture).
 *
 *  ID opératoire = PUBKEY (identité publique stable — la cible des traces
 *  ModerationAction/AdminAudit targetType='user' ; arbitrage §13.2 : l'URL
 *  /users/[id] porte la pubkey, PAS le cuid interne).
 *
 *  CURSOR OPAQUE : base64url JSON {k, w?, c, i} — k = clé de tri ("ins" |
 *  "rep") EMPÊCHE de rejouer un curseur sous un autre tri (400 sinon) ;
 *  w = poids (reports ouverts) pour le tri reports ; c = createdAt (ms) ;
 *  i = pubkey. Ancre disparue / hors filtres → RESTART page 1 + cursorReset
 *  (même sémantique queue Étape 6).
 *
 *  REPORTS REÇUS = reports OUVERTS sur les posts de l'utilisateur (arbitrage
 *  §13.6 — cohérent avec le poids de la queue Étape 6 : la colonne pilote
 *  l'action, pas la statistique historique).
 *
 *  STATUT : actif | suspendu (suspension ACTIVE — suspendedAt != null ET
 *  (suspendedUntil == null OU suspendedUntil > now), évaluation paresseuse
 *  identique aux points d'application) | banni (AUCUN champ schéma avant
 *  Étape 9 → filtre accepté, retourne 0 ligne — arbitrage §13.7).
 *
 *  DONNÉES : pseudo + pubkey + dates + compteurs — AUCUN email, AUCUNE IP,
 *  AUCUN contenu DM (invariants §1 d'ADMIN-RBAC.md).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PAGE_SIZE = 20;
const SEARCH_LIMIT = 20;

const PERIODS: Record<string, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

/** Suspension ACTIVE en SQL (copie exacte de l'évaluation paresseuse app). */
const SUSPENDED_SQL = `(u.suspendedAt IS NOT NULL AND (u.suspendedUntil IS NULL OR u.suspendedUntil > ?))`;

/** Condition + flag : consomme-t-elle le paramètre « now » (ordre des ?) ? */
const STATUS_COND: Record<string, { cond: string; needsNow: boolean }> = {
  actif: { cond: `NOT ${SUSPENDED_SQL}`, needsNow: true },
  suspendu: { cond: SUSPENDED_SQL, needsNow: true },
  // banni : aucun champ schéma avant Étape 9 (four-eyes) — filtre accepté,
  // retourne 0 ligne (arbitrage §13.7, pas de 400 : l'UI peut l'afficher).
  // PAS de placeholder : aucun paramètre ne doit être poussé (bug sondé).  
  banni: { cond: `1 = 0`, needsNow: false },
};

interface UsersCursor {
  k: "ins" | "rep";
  w?: number; // poids (tri reports uniquement)
  c: number; // createdAt (epoch ms)
  i: string; // pubkey
}

function decodeCursor(raw: string | null): UsersCursor | null | "malformed" {
  if (raw === null) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    const k = json.k;
    if (k !== "ins" && k !== "rep") return "malformed";
    if (
      typeof json.c !== "number" || !Number.isInteger(json.c) || json.c <= 0 ||
      typeof json.i !== "string" || json.i.length === 0 || json.i.length > 200
    ) {
      return "malformed";
    }
    if (k === "rep" && (typeof json.w !== "number" || !Number.isInteger(json.w) || json.w < 0)) {
      return "malformed";
    }
    return k === "rep" ? { k, w: json.w as number, c: json.c, i: json.i } : { k, c: json.c, i: json.i };
  } catch {
    return "malformed";
  }
}

function encodeCursor(c: UsersCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Échappe LIKE (%, _, \) — la recherche est un LIKE, pas une regex. */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.users");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const sort = sp.get("sort") === "reports" ? "reports" : "inscription"; // défaut : inscription
    const status = sp.get("status") ?? "all";
    const period = sp.get("period") ?? "all";
    if (!["all", "actif", "suspendu", "banni"].includes(status)) {
      return NextResponse.json(
        { error: "status invalide (actif | suspendu | banni | all)" },
        { status: 400 }
      );
    }
    if (!(period === "all" || period in PERIODS)) {
      return NextResponse.json(
        { error: "period invalide (24h | 7d | 30d | all)" },
        { status: 400 }
      );
    }
    const q = sp.get("q");
    if (q !== null && q.trim().length === 0) {
      return NextResponse.json({ error: "q vide (omettre le paramètre pour lister)" }, { status: 400 });
    }

    // ── MODE RECHERCHE : q présent → LIKE pseudo, limite 20, PAS de cursor ──
    if (q !== null) {
      const needle = `%${escapeLike(q.trim())}%`;
      const rows = await db.$queryRawUnsafe<Array<{
        pubkey: string; nickname: string; createdAt: Date;
        suspendedAt: Date | null; suspendedUntil: Date | null;
        postCount: number; openReports: number; warningCount: number;
      }>>(
        `SELECT u.pubkey, u.nickname, u.createdAt, u.suspendedAt, u.suspendedUntil,
                (SELECT COUNT(*) FROM Post p WHERE p.authorId = u.id) AS postCount,
                (SELECT COUNT(*) FROM Report r JOIN Post p2 ON p2.id = r.targetId
                  WHERE p2.authorId = u.id AND r.status = 'open') AS openReports,
                (SELECT COUNT(*) FROM UserWarning w WHERE w.userId = u.id) AS warningCount
         FROM User u
         WHERE u.nickname LIKE ? ESCAPE '\\'
         ORDER BY u.nickname COLLATE NOCASE ASC
         LIMIT ${SEARCH_LIMIT}`,
        needle
      );
      return NextResponse.json({
        mode: "search",
        items: rows.map(mapItem),
        total: rows.length,
        page: { size: SEARCH_LIMIT, sort, status, period, q: q.trim() },
      });
    }

    // ── MODE LISTE : cursor keyset (20/page) ────────────────────────────────
    const cursorOr = decodeCursor(sp.get("cursor"));
    if (cursorOr === "malformed") {
      return NextResponse.json({ error: "cursor invalide" }, { status: 400 });
    }
    // garde de VUE : un curseur émis sous un tri ne se rejoue pas sous l'autre
    // (k du curseur ≠ tri courant → 400, jamais un mélange de keysets).
    if (cursorOr && cursorOr.k !== (sort === "reports" ? "rep" : "ins")) {
      return NextResponse.json(
        { error: "cursor invalide (émis sous un autre tri — repartez de la page 1)" },
        { status: 400 }
      );
    }
    const sinceMs = period === "all" ? 0 : Date.now() - PERIODS[period];

    const baseParams: (string | number)[] = [];
    let statusCond = "1=1";
    if (status !== "all") {
      statusCond = STATUS_COND[status].cond;
      if (STATUS_COND[status].needsNow) baseParams.push(Date.now()); // param du « now » de SUSPENDED_SQL
    }
    const periodCond = sinceMs > 0 ? "AND u.createdAt >= ?" : "";
    if (sinceMs > 0) baseParams.push(sinceMs);

    // ancre : expirée ? (disparue ou ne satisfaisant plus les filtres)
    let cursor: UsersCursor | null = cursorOr;
    let cursorReset = false;
    if (cursor) {
      const anchor = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM User u WHERE u.pubkey = ? ${periodCond}`,
        cursor.i,
        ...(sinceMs > 0 ? [sinceMs] : [])
      );
      if (Number(anchor[0]?.n ?? 0) === 0) {
        cursor = null;
        cursorReset = true;
      }
    }

    // poids = reports ouverts sur les posts du user (tri reports uniquement)
    const weightExpr = `(SELECT COUNT(*) FROM Report r JOIN Post p ON p.id = r.targetId
                          WHERE p.authorId = u.id AND r.status = 'open')`;

    // keyset : inscription = createdAt DESC, id(pubkey) DESC (plus récents
    // d'abord — arbitrage §13.8) ; reports = weight DESC, createdAt ASC,
    // pubkey ASC (même tiebreak que la queue Étape 6 : ancienneté croissante).
    const keysetCond = cursor
      ? cursor.k === "ins"
        ? `WHERE (t.createdAt < ? OR (t.createdAt = ? AND t.pubkey < ?))`
        : `WHERE (t.weight < ?
             OR (t.weight = ? AND t.createdAt > ?)
             OR (t.weight = ? AND t.createdAt = ? AND t.pubkey > ?))`
      : "";
    const keysetParams: (string | number)[] =
      cursor === null
        ? []
        : cursor.k === "ins"
          ? [cursor.c, cursor.c, cursor.i]
          : [cursor.w as number, cursor.w as number, cursor.c, cursor.w as number, cursor.c, cursor.i];

    const order =
      sort === "reports"
        ? `ORDER BY t.weight DESC, t.createdAt ASC, t.pubkey ASC`
        : `ORDER BY t.createdAt DESC, t.pubkey DESC`;

    const rows = await db.$queryRawUnsafe<Array<{
      pubkey: string; nickname: string; createdAt: Date;
      suspendedAt: Date | null; suspendedUntil: Date | null;
      postCount: number; openReports: number; warningCount: number; weight: number;
    }>>(
      `SELECT * FROM (
         SELECT u.pubkey, u.nickname, u.createdAt, u.suspendedAt, u.suspendedUntil,
                (SELECT COUNT(*) FROM Post p WHERE p.authorId = u.id) AS postCount,
                (SELECT COUNT(*) FROM Report r JOIN Post p2 ON p2.id = r.targetId
                  WHERE p2.authorId = u.id AND r.status = 'open') AS openReports,
                (SELECT COUNT(*) FROM UserWarning w WHERE w.userId = u.id) AS warningCount,
                ${weightExpr} AS weight
         FROM User u
         WHERE ${statusCond} ${periodCond}
       ) t
       ${keysetCond}
       ${order}
       LIMIT ${PAGE_SIZE + 1}`,
      ...baseParams,
      ...keysetParams
    );

    const hasNext = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const totalUsers = await db.user.count();

    const last = page[page.length - 1];
    const nextCursor =
      hasNext && last
        ? sort === "reports"
          ? encodeCursor({ k: "rep", w: Number(last.weight), c: new Date(last.createdAt).getTime(), i: last.pubkey })
          : encodeCursor({ k: "ins", c: new Date(last.createdAt).getTime(), i: last.pubkey })
        : null;

    return NextResponse.json({
      mode: "list",
      items: page.map(mapItem),
      nextCursor,
      cursorReset,
      totalUsers,
      page: { size: PAGE_SIZE, sort, status, period },
    });
  } catch (e) {
    console.error("GET /api/internal/admin/users", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

function mapItem(r: {
  pubkey: string; nickname: string; createdAt: Date;
  suspendedAt: Date | null; suspendedUntil: Date | null;
  postCount: number; openReports: number; warningCount: number;
}) {
  const now = Date.now();
  const suspendedActive =
    r.suspendedAt !== null &&
    (r.suspendedUntil === null || r.suspendedUntil.getTime() > now);
  return {
    pubkey: r.pubkey,
    pseudo: r.nickname,
    createdAt: r.createdAt,
    postCount: Number(r.postCount),
    openReports: Number(r.openReports),
    warningCount: Number(r.warningCount),
    suspendedAt: r.suspendedAt,
    suspendedUntil: r.suspendedUntil,
    status: suspendedActive ? "suspendu" : "actif",
  };
}
