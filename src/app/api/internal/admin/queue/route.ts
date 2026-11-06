import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { auditSnippet } from "@/lib/mbote/moderation";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/queue — file de modération paginée (ADM Étape 6)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 6 : page /queue du panneau — liste paginée (CURSOR-BASED,
 *  20 par page) des Report où handledById IS NULL, tri Poids décroissant puis
 *  ancienneté croissante, filtres période / type / statut, poids = nombre de
 *  reports ouverts sur la même cible.
 *
 *  AUTH (directive + arbitrage §12.17) : requireAdmin({minRole:"support"}) —
 *  token interne + session + X-Admin-Actor (double contrôle Étape 4). L'auditor
 *  est STRICT (lecture seule AdminAudit) → 403 ici. GET = pas de CSRF.
 *
 *  CURSOR OPAQUE : base64url de JSON {w, c, i} — (weight, createdAt(ms),
 *  id) du DERNIER item de la page. Le tri vivant (poids recomputé à chaque
 *  requête) impose une clé de keyset complète : un curseur limité à
 *  (createdAt, id) serait instable dès qu'un poids change entre deux pages.
 *  - décodage malformé → 400 (jamais de restart silencieux) ;
 *  - ancre disparue / ne satisfaisant plus les filtres (cible fermée, purgée)
 *    → RESTART page 1 + flag `cursorReset: true` (directive : « cursor expiré
 *    → restart page 1 »).
 *
 *  PAGINATION APPROXIMATIVE SOUS MUTATION CONFORTE (documenté, ADM-step6 §5) :
 *  le poids d'une cible peut changer entre deux pages (nouveau report, hide) ;
 *  le keyset est exact sur l'instantané du tri, pas sur un ordre figé.
 *
 *  DONNÉES : pseudo d'affichage + identifiants opératoires (pubkeys —
 *  identités PUBLIQUES du mesh, cibles des actions warn/suspend). AUCUN email,
 *  AUCUNE IP, AUCUN contenu DM (invariants §1 d'ADMIN-RBAC.md). Extrait du
 *  post borné à 60 caractères (directive).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PAGE_SIZE = 20;
const SNIPPET_LEN = 60;

const PERIODS: Record<string, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

interface QueueCursor {
  w: number; // poids de la cible de l'ancre AU MOMENT de la page servie
  c: number; // createdAt de l'ancre (epoch ms — stockage Prisma/SQLite)
  i: string; // id de l'ancre
}

function decodeCursor(raw: string | null): QueueCursor | null | "malformed" {
  if (raw === null) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof json.w !== "number" || !Number.isInteger(json.w) || json.w < 0 ||
      typeof json.c !== "number" || !Number.isInteger(json.c) || json.c <= 0 ||
      typeof json.i !== "string" || json.i.length === 0 || json.i.length > 64
    ) {
      return "malformed";
    }
    return { w: json.w, c: json.c, i: json.i };
  } catch {
    return "malformed";
  }
}

function encodeCursor(c: QueueCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.queue");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const status = sp.get("status") === "all" ? "all" : "open"; // défaut : open
    const period = sp.get("period") ?? "all";
    const type = sp.get("type") ?? "all";
    if (!(period === "all" || period in PERIODS)) {
      return NextResponse.json(
        { error: "period invalide (24h | 7d | 30d | all)" },
        { status: 400 }
      );
    }
    if (!["all", "post", "comment"].includes(type)) {
      return NextResponse.json(
        { error: "type invalide (post | comment | all)" },
        { status: 400 }
      );
    }
    const cursorOr = decodeCursor(sp.get("cursor"));
    if (cursorOr === "malformed") {
      return NextResponse.json({ error: "cursor invalide" }, { status: 400 });
    }

    const sinceMs = period === "all" ? 0 : Date.now() - PERIODS[period];

    // ── conditions de BASE (appliquées au curseur ET au restart) ────────────
    // statut : open ≡ handledById IS NULL (directive, à la lettre — arbitrage
    // ADM-step5 §5.2 : le champ coïncide avec status='open' aujourd'hui).
    const statusCond = status === "open" ? "r.handledById IS NULL" : "1=1";
    const periodCond = sinceMs > 0 ? "AND r.createdAt >= ?" : "";
    const typeCond = type !== "all" ? "AND r.targetKind = ?" : "";
    const baseParams: (string | number)[] = [];
    if (sinceMs > 0) baseParams.push(sinceMs);
    if (type !== "all") baseParams.push(type);

    const weightExpr = `(SELECT COUNT(*) FROM Report ro WHERE ro.status='open' AND ro.targetKind = r.targetKind AND ro.targetId = r.targetId)`;

    // ── ancre du curseur : expirée ? ────────────────────────────────────────
    let cursor: QueueCursor | null = cursorOr;
    let cursorReset = false;
    if (cursor) {
      const anchor = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM Report r
         WHERE r.id = ? AND ${statusCond} ${periodCond} ${typeCond}`,
        ...[cursor.i, ...baseParams]
      );
      if (Number(anchor[0]?.n ?? 0) === 0) {
        // ancre disparue (purgée) ou ne satisfaisant plus les filtres
        // (cible fermée entre deux pages) → restart page 1, proprement.
        cursor = null;
        cursorReset = true;
      }
    }

    // ── keyset sur la clé de tri COMPLÈTE (weight DESC, createdAt ASC, id ASC)
    // 100 % paramétré (aucune interpolation du curseur dans le SQL) — les
    // placeholders apparaissent dans l'ordre textuel : base d'abord (sous-
    // requête), keyset ensuite. $queryRawUnsafe : SQL dynamique + params
    // positionnels ($queryRaw est une tag function, pas un appel).
    const keysetCond = cursor
      ? `WHERE (t.weight < ?
           OR (t.weight = ? AND t.createdAt > ?)
           OR (t.weight = ? AND t.createdAt = ? AND t.id > ?))`
      : "";
    const keysetParams: (string | number)[] = cursor
      ? [cursor.w, cursor.w, cursor.c, cursor.w, cursor.c, cursor.i]
      : [];

    const rows = await db.$queryRawUnsafe<Array<{
      id: string;
      reporterKey: string;
      targetKind: string;
      targetId: string;
      reason: string;
      details: string | null;
      status: string;
      handledAt: Date | null;
      createdAt: Date;
      weight: number;
      postContent: string | null;
      postCreatedAt: Date | null;
      postHiddenAt: Date | null;
      authorNickname: string | null;
      authorPubkey: string | null;
      authorSuspendedAt: Date | null;
      reporterNickname: string | null;
    }>>(
      `SELECT * FROM (
         SELECT r.id, r.reporterKey, r.targetKind, r.targetId, r.reason, r.details,
                r.status, r.handledAt, r.createdAt,
                ${weightExpr} AS weight,
                p.content AS postContent, p.createdAt AS postCreatedAt,
                p.hiddenAt AS postHiddenAt,
                au.nickname AS authorNickname, au.pubkey AS authorPubkey,
                au.suspendedAt AS authorSuspendedAt,
                ru.nickname AS reporterNickname
         FROM Report r
         LEFT JOIN Post p ON p.id = r.targetId
         LEFT JOIN User au ON au.id = p.authorId
         LEFT JOIN User ru ON ru.pubkey = r.reporterKey
         WHERE ${statusCond} ${periodCond} ${typeCond}
       ) t
       ${keysetCond}
       ORDER BY t.weight DESC, t.createdAt ASC, t.id ASC
       LIMIT ${PAGE_SIZE + 1}`,
      ...baseParams,
      ...keysetParams
    );

    const hasNext = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);

    const openTotal = await db.report.count({ where: { handledById: null } });

    const items = page.map((r) => ({
      id: r.id,
      reporter: { pseudo: r.reporterNickname ?? null },
      targetKind: r.targetKind,
      targetId: r.targetId,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.createdAt,
      weight: Number(r.weight),
      context: r.postContent
        ? {
            exists: true,
            snippet: auditSnippet(r.postContent, SNIPPET_LEN),
            postCreatedAt: r.postCreatedAt,
            hiddenAt: r.postHiddenAt,
            author: {
              pseudo: r.authorNickname,
              pubkey: r.authorPubkey, // cible opératoire des actions warn/suspend
              suspendedAt: r.authorSuspendedAt,
            },
          }
        : {
            exists: false,
            note: "contenu absent de la DB (purgé) — voir ModerationAction action=purge",
          },
    }));

    const last = page[page.length - 1];
    const nextCursor = hasNext && last
      ? encodeCursor({ w: Number(last.weight), c: new Date(last.createdAt).getTime(), i: last.id })
      : null;

    return NextResponse.json({
      items,
      nextCursor,
      cursorReset,
      openTotal,
      page: { size: PAGE_SIZE, status, period, type },
    });
  } catch (e) {
    console.error("GET /api/internal/admin/queue", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
