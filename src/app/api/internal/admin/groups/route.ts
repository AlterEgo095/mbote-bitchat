import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/groups — annuaire des groupes privés MLS (C4)
 *  (back-office 2026-11 : métadonnées d'annuaire — JAMAIS de contenu)
 * ─────────────────────────────────────────────────────────────────────────────
 *  PÉRIMÈTRE E2EE : le serveur est un RELAIS AVEUGLE (MLS RFC 9420).
 *  GroupMessage.ciphertext et GroupEnvelope.payload sont des ciphertext
 *  OPAQUES — cet endpoint ne renvoie QUE des métadonnées d'annuaire :
 *  nom, identifiant MLS, clés publiques (publiques par définition),
 *  COMPTEURS (membres, messages, enveloppes) et DATES. AUCUN ciphertext,
 *  AUCUN payload (invariant §1.4 ADMIN-RBAC.md). mlsEpoch (BigInt) n'est
 *  PAS exposé dans la liste — il l'est uniquement dans la fiche /groups/[id]
 *  (conversion prudente Number si sûr, sinon string).
 *
 *  AUTH : requireAdmin({minRole:"support"}) — lecture ; l'auditor reste
 *  STRICT (403). GET → pas de CSRF.
 *
 *  FILTRES :
 *   - period : 24h | 7d | 30d | all — fenêtre de CRÉATION du groupe
 *     (g.createdAt >= since — même sémantique « inscription » que
 *     l'annuaire users) ;
 *   - q : LIKE sur name OU mlsGroupId (2..200 chars, %/_/\ échappés —
 *     la recherche est un LIKE, pas une regex) → mode « search », limite
 *     20, PAS de cursor ;
 *   - cursor : pagination keyset (mode « list », 20/page).
 *
 *  CURSOR OPAQUE : base64url JSON {k:"groups", c, i} — c = epoch ms de la
 *  clé de tri COALESCE(lastMessageAt, createdAt) (activité du groupe,
 *  ancrée sur sa création s'il n'a aucun message), i = id du groupe. La
 *  GARDE DE VUE (k ≠ "groups" → 400) empêche de rejouer un curseur émis
 *  par un autre annuaire ; ancre disparue (groupe purgé en cascade) →
 *  RESTART page 1 + cursorReset:true (sémantique identique posts/users/
 *  queue). TRI : (COALESCE(lastMessageAt, createdAt) DESC, id DESC) — id
 *  en tiebreak (les groupes créés à la même ms restent ordonnés).
 *
 *  TOTALS : statistiques RÉSEAU globales (hors filtres q/period) —
 *  l'annuaire est une vue de santé, pas une recherche : comptes absolus
 *  + activité 24 h. LIKE échappé, SQL brut paramétré (?) uniquement,
 *  BigInt → Number() partout (COUNT/SUM/MAX/COALESCE renvoient des BigInt
 *  côté driver raw — jamais sérialisés tels quels, sinon 500 JSON).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PAGE_SIZE = 20;
const SEARCH_LIMIT = 20;

const PERIODS: Record<string, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

interface GroupsCursor {
  k: "groups";
  c: number; // epoch ms de COALESCE(lastMessageAt, createdAt) de l'ancre
  i: string; // id du groupe (ancre)
}

function decodeCursor(raw: string | null): GroupsCursor | null | "malformed" {
  if (raw === null) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      json.k !== "groups" ||
      typeof json.c !== "number" || !Number.isInteger(json.c) || json.c <= 0 ||
      typeof json.i !== "string" || json.i.length === 0 || json.i.length > 128
    ) {
      return "malformed";
    }
    return { k: "groups", c: json.c, i: json.i };
  } catch {
    return "malformed";
  }
}

function encodeCursor(c: GroupsCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Échappe LIKE (%, _, \) — la recherche est un LIKE, pas une regex. */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Colonnes de la liste (agrégats par sous-requêtes GROUP BY — un seul
 * balayage par table). NB : « Group » est QUOTÉ — GROUP est un mot réservé
 * SQLite (syntax error sinon). sortAt = clé de tri keyset ; COALESCE est
 * une expression SANS decltype DATETIME → le driver raw renvoie BigInt
 * (epoch ms), jamais un Date.
 */
const SELECT_COLS = `g.id, g.name, g.mlsGroupId, g.creatorKey, g.createdAt,
       COALESCE(m.memberCount, 0) AS memberCount,
       COALESCE(m.activeMemberCount, 0) AS activeMemberCount,
       COALESCE(msg.messageCount, 0) AS messageCount,
       COALESCE(env.envelopeCount, 0) AS envelopeCount,
       msg.lastMessageAt AS lastMessageAt,
       COALESCE(msg.lastMessageAt, g.createdAt) AS sortAt`;

const JOIN_SUBS = `LEFT JOIN (SELECT groupId, COUNT(*) AS memberCount,
                    SUM(CASE WHEN leftAt IS NULL THEN 1 ELSE 0 END) AS activeMemberCount
             FROM GroupMember GROUP BY groupId) m ON m.groupId = g.id
       LEFT JOIN (SELECT groupId, COUNT(*) AS messageCount, MAX(createdAt) AS lastMessageAt
             FROM GroupMessage GROUP BY groupId) msg ON msg.groupId = g.id
       LEFT JOIN (SELECT groupId, COUNT(*) AS envelopeCount
             FROM GroupEnvelope GROUP BY groupId) env ON env.groupId = g.id`;

interface RawGroupRow {
  id: string;
  name: string;
  mlsGroupId: string;
  creatorKey: string;
  createdAt: Date;
  memberCount: bigint;
  activeMemberCount: bigint;
  messageCount: bigint;
  envelopeCount: bigint;
  /** MAX(createdAt) du groupe — BigInt (epoch ms) ou null si aucun message */
  lastMessageAt: bigint | null;
  /** clé de tri keyset — COALESCE(expr) → BigInt (epoch ms) */
  sortAt: bigint;
}

interface RawTotalsRow {
  groups: bigint;
  members: bigint;
  messages: bigint;
  envelopes: bigint;
  last24hMessages: bigint;
}

function mapItem(r: RawGroupRow) {
  return {
    id: r.id,
    name: r.name,
    mlsGroupId: r.mlsGroupId,
    creatorKey: r.creatorKey,
    memberCount: Number(r.memberCount),
    activeMemberCount: Number(r.activeMemberCount),
    messageCount: Number(r.messageCount),
    envelopeCount: Number(r.envelopeCount),
    lastMessageAt: r.lastMessageAt === null ? null : new Date(Number(r.lastMessageAt)),
    createdAt: r.createdAt,
  };
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.groups");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const period = sp.get("period") ?? "all";
    if (!(period === "all" || period in PERIODS)) {
      return NextResponse.json(
        { error: "period invalide (24h | 7d | 30d | all)" },
        { status: 400 }
      );
    }
    const q = sp.get("q");
    if (q !== null && (q.trim().length < 2 || q.trim().length > 200)) {
      return NextResponse.json(
        { error: "q invalide (2..200 caractères — omettre le paramètre pour lister)" },
        { status: 400 }
      );
    }

    // ── conditions de BASE (partagées : recherche, liste, ancre du curseur) ──
    const baseParams: (string | number)[] = [];
    const sinceMs = period === "all" ? 0 : Date.now() - PERIODS[period];
    const periodCond = sinceMs > 0 ? "AND g.createdAt >= ?" : "";
    if (sinceMs > 0) baseParams.push(sinceMs);
    const baseWhere = `WHERE 1=1 ${periodCond}`;

    // ── totals RÉSEAU globaux (hors filtres) — une requête unique à sous-
    //    requêtes scalaires ; COUNT → BigInt → Number(). ───────────────────
    const totalsRows = await db.$queryRawUnsafe<Array<RawTotalsRow>>(
      `SELECT
         (SELECT COUNT(*) FROM "Group") AS groups,
         (SELECT COUNT(*) FROM GroupMember WHERE leftAt IS NULL) AS members,
         (SELECT COUNT(*) FROM GroupMessage) AS messages,
         (SELECT COUNT(*) FROM GroupEnvelope) AS envelopes,
         (SELECT COUNT(*) FROM GroupMessage WHERE createdAt >= ?) AS last24hMessages`,
      Date.now() - 24 * 3600_000
    );
    const totalsRow = totalsRows[0];
    const totals = {
      groups: Number(totalsRow?.groups ?? 0),
      members: Number(totalsRow?.members ?? 0),
      messages: Number(totalsRow?.messages ?? 0),
      envelopes: Number(totalsRow?.envelopes ?? 0),
      last24hMessages: Number(totalsRow?.last24hMessages ?? 0),
    };

    // ── MODE RECHERCHE : q présent → LIKE name/mlsGroupId, limite 20, PAS
    //    de cursor (même arbitrage que l'annuaire posts). ───────────────────
    if (q !== null) {
      const needle = `%${escapeLike(q.trim())}%`;
      const rows = await db.$queryRawUnsafe<Array<RawGroupRow>>(
        `SELECT ${SELECT_COLS}
         FROM "Group" g
         ${JOIN_SUBS}
         ${baseWhere}
           AND (g.name LIKE ? ESCAPE '\\' OR g.mlsGroupId LIKE ? ESCAPE '\\')
         ORDER BY COALESCE(msg.lastMessageAt, g.createdAt) DESC, g.id DESC
         LIMIT ${SEARCH_LIMIT}`,
        ...baseParams,
        needle,
        needle
      );
      return NextResponse.json({
        mode: "search",
        items: rows.map(mapItem),
        nextCursor: null,
        cursorReset: false,
        totals,
        e2ee: true,
      });
    }

    // ── MODE LISTE : cursor keyset (20/page) ────────────────────────────────
    const cursorOr = decodeCursor(sp.get("cursor"));
    if (cursorOr === "malformed") {
      return NextResponse.json({ error: "cursor invalide" }, { status: 400 });
    }
    if (cursorOr && cursorOr.k !== "groups") {
      return NextResponse.json(
        { error: "cursor invalide (émis sous un autre annuaire — repartez de la page 1)" },
        { status: 400 }
      );
    }

    // ancre : disparue (groupe purgé) ou ne satisfaisant plus les filtres →
    // restart page 1 + cursorReset (même sémantique posts/users/queue)
    let cursor: GroupsCursor | null = cursorOr;
    let cursorReset = false;
    if (cursor) {
      const anchor = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n
         FROM "Group" g
         ${baseWhere} AND g.id = ?`,
        ...baseParams,
        cursor.i
      );
      if (Number(anchor[0]?.n ?? 0) === 0) {
        cursor = null;
        cursorReset = true;
      }
    }

    const keysetCond = cursor
      ? `WHERE (t.sortAt < ? OR (t.sortAt = ? AND t.id < ?))`
      : "";
    const keysetParams: (string | number)[] = cursor
      ? [cursor.c, cursor.c, cursor.i]
      : [];

    const rows = await db.$queryRawUnsafe<Array<RawGroupRow>>(
      `SELECT * FROM (
         SELECT ${SELECT_COLS}
         FROM "Group" g
         ${JOIN_SUBS}
         ${baseWhere}
       ) t
       ${keysetCond}
       ORDER BY t.sortAt DESC, t.id DESC
       LIMIT ${PAGE_SIZE + 1}`,
      ...baseParams,
      ...keysetParams
    );

    const hasNext = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const nextCursor =
      hasNext && last
        ? encodeCursor({ k: "groups", c: Number(last.sortAt), i: last.id })
        : null;

    return NextResponse.json({
      mode: "list",
      items: page.map(mapItem),
      nextCursor,
      cursorReset,
      totals,
      e2ee: true,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/groups", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
