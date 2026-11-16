import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/dms — annuaire des paires DM (MÉTADONNÉES ONLY)
 *  (back-office 2026-11 : « qui parle à qui, combien, quand » — jamais « quoi »)
 * ─────────────────────────────────────────────────────────────────────────────
 *  INVARIANT ABSOLU (ADMIN-RBAC §1.4) : les DM sont E2EE — le serveur ne
 *  stocke QUE du chiffré opaque (DirectMessage.iv + ciphertext AES-GCM sur
 *  ECDH P-256, clés dérivées côté client). AUCUN contenu lisible n'existe côté
 *  serveur : cet endpoint ne renvoie donc que des MÉTADONNÉES agrégées par
 *  paire — compteurs (messages, non lus, legacy), tailles (LENGTH(ciphertext),
 *  jamais le ciphertext lui-même), timestamps — JAMAIS `iv`, JAMAIS
 *  `ciphertext`. Le badge `e2ee: true` dans la réponse est un CONTRAT : cette
 *  vue ne contient aucun contenu, par construction. Un admin peut cartographier
 *  le graphe social et détecter des anomalies de trafic (volume anormal,
 *  enveloppes legacy non migrées) sans jamais pouvoir lire un message.
 *
 *  PAIRE CANONIQUE : pairKey = les deux clés triées asc jointes par "|"
 *  (SQL CASE WHEN senderKey <= recipientKey ...) — A→B et B→A sont la MÊME
 *  conversation ; la direction par message n'est exposée que dans
 *  /api/internal/admin/dms/messages.
 *
 *  MODE RECHERCHE : q présent → fragment de pubkey (≥ 3 caractères, ≤ 200),
 *  LIKE %needle% échappé (ESCAPE '\') sur senderKey/recipientKey — limite 20,
 *  pas de cursor.
 *  MODE LISTE : cursor keyset 20/page sur (lastMessageAt DESC, keyB DESC,
 *  keyA DESC) — les agrégats sont recalculés à chaque page (GROUP BY vivant,
 *  pas d'instantané persistant).
 *
 *  FILTRES :
 *   - status : all | unread (HAVING SUM(readAt IS NULL) > 0) ;
 *   - period : 24h | 7d | 30d | all (AND createdAt >= epoch ms).
 *
 *  CURSOR OPAQUE : base64url JSON {k:"dms", c, a, b} (c = lastMessageAt de
 *  l'ancre en epoch ms, a/b = la paire canonique) — GARDE DE VUE (k ≠ "dms"
 *  → 400 « émis sous un autre annuaire ») contre le rejeu d'un curseur d'un
 *  autre annuaire ; ancre disparue (la paire ne satisfait plus les
 *  filtres/agrégats — SELECT d'existence sous les MÊMES WHERE/HAVING, 0
 *  ligne) → RESTART page 1 + `cursorReset: true` (sémantique users/queue/
 *  posts). PAGINATION APPROXIMATIVE SOUS MUTATION CONFORTE (ADM-step6 §5) :
 *  lastMessageAt est une clé de tri VIVANTE (un nouveau DM dans la paire
 *  peut la faire réapparaître sur la page suivante) — le keyset est exact
 *  sur l'instantané.
 *
 *  AUTH : requireAdmin({minRole:"support"}) — même arbitrage §13.1 que
 *  l'annuaire posts (lecture) ; l'auditor reste STRICT (403 auto via
 *  roleAtLeast).
 *
 *  TOTALS : aperçu GLOBAL de toute la table (SANS filtres — indépendant de la
 *  vue courante) : pairs / messages / unread / bytes / last24h.
 *
 *  DONNÉES : SQLite renvoie les agrégats (COUNT/SUM/LENGTH/MIN/MAX) en BigInt
 *  → Number() systématique ; les DATETIME sont stockés en epoch ms et les
 *  agrégats MIN/MAX ne passent PAS par la conversion Date de Prisma → new
 *  Date(Number(...)) (NextResponse.json sérialise en ISO, comme posts).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PAGE_SIZE = 20;
const SEARCH_LIMIT = 20;

const PERIODS: Record<string, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

/**
 * Colonnes agrégées PAR PAIRE CANONIQUE — métadonnées only : compteurs,
 * LENGTH(ciphertext) (taille, jamais le contenu), timestamps. AUCUN `iv`,
 * AUCUN `ciphertext` dans ce SELECT (invariant §1.4).
 */
const AGG_COLS = `CASE WHEN d.senderKey <= d.recipientKey THEN d.senderKey ELSE d.recipientKey END AS keyA,
       CASE WHEN d.senderKey <= d.recipientKey THEN d.recipientKey ELSE d.senderKey END AS keyB,
       COUNT(*) AS messageCount,
       SUM(CASE WHEN d.readAt IS NULL THEN 1 ELSE 0 END) AS unreadCount,
       SUM(LENGTH(d.ciphertext)) AS bytes,
       MIN(d.createdAt) AS firstMessageAt,
       MAX(d.createdAt) AS lastMessageAt,
       SUM(CASE WHEN d.msgId IS NULL THEN 1 ELSE 0 END) AS legacyCount`;

/** Filtre unread partagé (HAVING) — sous forme agrégée pour rester composable. */
const UNREAD_HAVING = "SUM(CASE WHEN d.readAt IS NULL THEN 1 ELSE 0 END) > 0";

interface DmsCursor {
  k: "dms";
  c: number; // lastMessageAt de l'ancre (epoch ms)
  a: string; // keyA de l'ancre (paire canonique)
  b: string; // keyB de l'ancre
}

/**
 * Décode le cursor opaque. Renvoie :
 *  - null            : pas de cursor (page 1) ;
 *  - "wrong-view"    : garde de vue — le cursor a été émis sous un AUTRE
 *                      annuaire (k ≠ "dms") → 400 dédié (message distinct,
 *                      plus Actionable que « invalide ») ;
 *  - "malformed"     : illisible / champs absents / type incorrect → 400.
 */
function decodeCursor(raw: string | null): DmsCursor | null | "malformed" | "wrong-view" {
  if (raw === null) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (json.k !== "dms") return "wrong-view";
    if (
      typeof json.c !== "number" || !Number.isInteger(json.c) || json.c <= 0 ||
      typeof json.a !== "string" || json.a.length === 0 || json.a.length > 200 ||
      typeof json.b !== "string" || json.b.length === 0 || json.b.length > 200 ||
      json.a > json.b
    ) {
      return "malformed";
    }
    return { k: "dms", c: json.c, a: json.a, b: json.b };
  } catch {
    return "malformed";
  }
}

function encodeCursor(c: DmsCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Échappe LIKE (%, _, \) — la recherche est un LIKE, pas une regex. */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Liste blanche des filtres statut. */
const STATUS_FILTERS = ["all", "unread"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.dms");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const status = sp.get("status") ?? "all";
    const period = sp.get("period") ?? "all";
    const q = sp.get("q");

    if (!(STATUS_FILTERS as readonly string[]).includes(status)) {
      return NextResponse.json({ error: "status invalide (all | unread)" }, { status: 400 });
    }
    if (!(period === "all" || period in PERIODS)) {
      return NextResponse.json({ error: "period invalide (24h | 7d | 30d | all)" }, { status: 400 });
    }
    const trimmedQ = q === null ? "" : q.trim();
    if (q !== null && trimmedQ.length === 0) {
      return NextResponse.json({ error: "q vide (omettre le paramètre pour lister)" }, { status: 400 });
    }
    if (q !== null && trimmedQ.length < 3) {
      return NextResponse.json({ error: "q trop court (≥ 3 caractères)" }, { status: 400 });
    }
    if (q !== null && trimmedQ.length > 200) {
      return NextResponse.json({ error: "q trop long (≤ 200 caractères)" }, { status: 400 });
    }

    // ── conditions de BASE (partagées : recherche, liste, ancre du curseur) ──
    const baseParams: (string | number)[] = [];
    const sinceMs = period === "all" ? 0 : Date.now() - PERIODS[period];
    const periodCond = sinceMs > 0 ? "AND d.createdAt >= ?" : "";
    if (sinceMs > 0) baseParams.push(sinceMs);
    const qCond =
      q !== null
        ? "AND (d.senderKey LIKE ? ESCAPE '\\' OR d.recipientKey LIKE ? ESCAPE '\\')"
        : "";
    if (q !== null) {
      const needle = `%${escapeLike(trimmedQ)}%`;
      baseParams.push(needle, needle);
    }
    const baseWhere = `WHERE 1=1 ${periodCond} ${qCond}`;
    const havingUnread = (status as StatusFilter) === "unread" ? `HAVING ${UNREAD_HAVING}` : "";

    // ── TOTALS : aperçu GLOBAL (toute la table, SANS filtres) — requêtes ─────
    // séparées de la page ; BigInt SQLite → Number() systématique.
    const totalsRow = await db.$queryRawUnsafe<Array<RawTotalsRow>>(
      `SELECT COUNT(*) AS messages,
              SUM(CASE WHEN readAt IS NULL THEN 1 ELSE 0 END) AS unread,
              SUM(LENGTH(ciphertext)) AS bytes,
              SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END) AS last24h
       FROM DirectMessage`,
      Date.now() - PERIODS["24h"]
    );
    const pairsCount = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM (
         SELECT CASE WHEN senderKey <= recipientKey THEN senderKey ELSE recipientKey END AS keyA,
                CASE WHEN senderKey <= recipientKey THEN recipientKey ELSE senderKey END AS keyB
         FROM DirectMessage
         GROUP BY keyA, keyB
       )`
    );
    const t = totalsRow[0];
    const totals = {
      pairs: Number(pairsCount[0]?.n ?? 0),
      messages: Number(t?.messages ?? 0),
      unread: Number(t?.unread ?? 0),
      bytes: Number(t?.bytes ?? 0),
      last24h: Number(t?.last24h ?? 0),
    };

    // ── MODE RECHERCHE : q présent → LIKE pubkey, limite 20, PAS de cursor ──
    if (q !== null) {
      const rows = await db.$queryRawUnsafe<Array<RawPairRow>>(
        `SELECT ${AGG_COLS}
         FROM DirectMessage d
         ${baseWhere}
         GROUP BY keyA, keyB
         ${havingUnread}
         ORDER BY lastMessageAt DESC, keyB DESC, keyA DESC
         LIMIT ${SEARCH_LIMIT}`,
        ...baseParams
      );
      return NextResponse.json({
        mode: "search",
        items: rows.map(mapItem),
        total: rows.length,
        nextCursor: null,
        cursorReset: false,
        totals,
        page: { size: SEARCH_LIMIT, status, period, q: trimmedQ },
        e2ee: true, // BADGE E2EE : métadonnées only, aucun iv/ciphertext (invariant §1.4)
      });
    }

    // ── MODE LISTE : cursor keyset (20/page) ────────────────────────────────
    const cursorOr = decodeCursor(sp.get("cursor"));
    if (cursorOr === "malformed") {
      return NextResponse.json({ error: "cursor invalide" }, { status: 400 });
    }
    if (cursorOr === "wrong-view") {
      return NextResponse.json(
        { error: "cursor invalide (émis sous un autre annuaire — repartez de la page 1)" },
        { status: 400 }
      );
    }

    // ancre : la paire ne satisfait plus les filtres/agrégats (plus de DM dans
    // la fenêtre, tout lu sous status=unread, etc.) → restart page 1 (SELECT
    // d'existence de la paire sous les MÊMES WHERE/HAVING)
    let cursor: DmsCursor | null = cursorOr;
    let cursorReset = false;
    if (cursor) {
      const anchor = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n
         FROM (
           SELECT CASE WHEN d.senderKey <= d.recipientKey THEN d.senderKey ELSE d.recipientKey END AS keyA,
                  CASE WHEN d.senderKey <= d.recipientKey THEN d.recipientKey ELSE d.senderKey END AS keyB
           FROM DirectMessage d
           ${baseWhere}
           GROUP BY keyA, keyB
           ${havingUnread}
         ) g
         WHERE g.keyA = ? AND g.keyB = ?`,
        ...baseParams,
        cursor.a,
        cursor.b
      );
      if (Number(anchor[0]?.n ?? 0) === 0) {
        cursor = null;
        cursorReset = true;
      }
    }

    const keysetCond = cursor
      ? `WHERE (t.lastMessageAt < ? OR (t.lastMessageAt = ? AND (t.keyB < ? OR (t.keyB = ? AND t.keyA < ?))))`
      : "";
    const keysetParams: (string | number)[] = cursor
      ? [cursor.c, cursor.c, cursor.b, cursor.b, cursor.a]
      : [];

    const rows = await db.$queryRawUnsafe<Array<RawPairRow>>(
      `SELECT * FROM (
         SELECT ${AGG_COLS}
         FROM DirectMessage d
         ${baseWhere}
         GROUP BY keyA, keyB
         ${havingUnread}
       ) t
       ${keysetCond}
       ORDER BY t.lastMessageAt DESC, t.keyB DESC, t.keyA DESC
       LIMIT ${PAGE_SIZE + 1}`,
      ...baseParams,
      ...keysetParams
    );

    const hasNext = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const nextCursor =
      hasNext && last
        ? encodeCursor({ k: "dms", c: Number(last.lastMessageAt), a: last.keyA, b: last.keyB })
        : null;

    return NextResponse.json({
      mode: "list",
      items: page.map(mapItem),
      nextCursor,
      cursorReset,
      totals,
      e2ee: true, // BADGE E2EE : métadonnées only, aucun iv/ciphertext (invariant §1.4)
      page: { size: PAGE_SIZE, status, period, q: null },
    });
  } catch (e) {
    console.error("GET /api/internal/admin/dms", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

interface RawPairRow {
  keyA: string;
  keyB: string;
  messageCount: bigint;
  unreadCount: bigint;
  bytes: bigint; // SUM(LENGTH(ciphertext)) — taille du chiffré, JAMAIS le contenu
  /** epoch ms — MIN/MAX de DATETIME ne passent pas par la conversion Date de Prisma */
  firstMessageAt: bigint;
  lastMessageAt: bigint;
  legacyCount: bigint;
}

interface RawTotalsRow {
  messages: bigint;
  unread: bigint | null; // SUM → null si table vide
  bytes: bigint | null;
  last24h: bigint | null;
}

function mapItem(r: RawPairRow) {
  return {
    pair: `${r.keyA}|${r.keyB}`,
    keyA: r.keyA,
    keyB: r.keyB,
    messageCount: Number(r.messageCount),
    unreadCount: Number(r.unreadCount),
    bytes: Number(r.bytes),
    // Date → sérialisée en ISO string par NextResponse.json (comme posts)
    firstMessageAt: new Date(Number(r.firstMessageAt)),
    lastMessageAt: new Date(Number(r.lastMessageAt)),
    legacyCount: Number(r.legacyCount),
  };
}
