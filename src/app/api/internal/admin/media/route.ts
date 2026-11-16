import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin, writeAdminAudit } from "@/lib/mbote/admin-auth";
import { parseJustification } from "@/lib/mbote/justification";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/media — annuaire des médias chiffrés (B2)
 *  POST /api/internal/admin/media — purges média (justification §6)
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET (minRole "support") — MÉTADONNÉES uniquement : le serveur stocke le
 *  CIPHERTEXT du client dans un bucket S3-compatible (clés sans identité,
 *  spec MEDIA-ENVELOPE-SPEC §4.2) et ne tient ici que la correspondance
 *  mediaId ↔ objectKey + le décompte de quota. sizeBytes/plainBytes/sha256
 *  sont des métadonnées légitimes (tailles du ciphertext / plaintext
 *  DÉCLARÉ, empreinte de dédup) — aucun octet de contenu, aucun plaintext.
 *   - Filtres : status (all | pending | finalized), period (24h|7d|30d|all,
 *     fenêtre de création), owner (pubkey exacte — depuis une fiche user) ;
 *   - Cursor keyset opaque {k:"media", c, i} : tri (createdAt DESC, id
 *     DESC), garde de vue k ≠ "media" → 400, ancre disparue → restart page
 *     1 + cursorReset:true (sémantique posts/users/groups) ;
 *   - totals GLOBAL (hors filtres) : volume total finalisé, volume pending,
 *     pendings « expirés 24 h » (jamais finalisés depuis > 24 h = orphelins
 *     de candidats à la purge).
 *
 *  POST (minRole "moderator", mutation:true — CSRF requis) — DEUX purges :
 *   - purge_media : id requis → supprime la LIGNE DB (404 si absente).
 *     Le FICHIER bucket n'est PAS supprimable aujourd'hui : media/storage.ts
 *     n'expose QUE des URLs présignées PUT/GET (SigV4) — aucun helper de
 *     suppression objet. On note fileDeleted:false + motif dans l'audit ;
 *     l'objet ciphertext orphelin reste dans le bucket (GC hors périmètre).
 *   - purge_pending_expired : deleteMany des pendings jamais finalisés
 *     depuis maxAgeHours (défaut 24, borné 1..720). Les octets libérés
 *     (somme sizeBytes) sont agrégés AVANT le delete (fenêtre de course
 *     documentée : le deleteMany re-compte exactement, l'agrégat peut
 *     différer de quelques lignes sous mutation concurrente).
 *
 *  JUSTIFICATION §6 : TOUTE mutation valide {category, justification} via
 *  parseJustification (forme « CATÉGORIE: texte » ≥ 20 chars) — 422 sinon.
 *  AUDIT : chaque purge écrit UNE ligne ModerationAction (hors transaction —
 *  opération simple non critique à l'atomicité) + UNE ligne AdminAudit
 *  append-only (writeAdminAudit). 400 corps illisible / action inconnue.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PAGE_SIZE = 20;

const PERIODS: Record<string, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

/** Bornes du paramètre purge_pending_expired.maxAgeHours. */
const MAX_AGE_HOURS_MIN = 1;
const MAX_AGE_HOURS_MAX = 720;
const MAX_AGE_HOURS_DEFAULT = 24;

interface MediaCursor {
  k: "media";
  c: number; // createdAt de l'ancre (epoch ms)
  i: string; // id de l'ancre
}

function decodeCursor(raw: string | null): MediaCursor | null | "malformed" {
  if (raw === null) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      json.k !== "media" ||
      typeof json.c !== "number" || !Number.isInteger(json.c) || json.c <= 0 ||
      typeof json.i !== "string" || json.i.length === 0 || json.i.length > 128
    ) {
      return "malformed";
    }
    return { k: "media", c: json.c, i: json.i };
  } catch {
    return "malformed";
  }
}

function encodeCursor(c: MediaCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Liste blanche des filtres statut (valeurs du schéma Media.status). */
const STATUS_FILTERS = ["all", "pending", "finalized"] as const;

interface RawMediaRow {
  id: string;
  objectKey: string;
  ownerPubkey: string;
  mediaType: string;
  sizeBytes: number;
  plainBytes: number;
  sha256: string | null;
  status: string;
  createdAt: Date;
  finalizedAt: Date | null;
}

interface RawMediaTotalsRow {
  count: bigint;
  bytes: bigint;
  pendingCount: bigint;
  pendingBytes: bigint;
  pendingExpired24h: bigint;
}

function mapItem(r: RawMediaRow) {
  return {
    id: r.id,
    objectKey: r.objectKey,
    ownerPubkey: r.ownerPubkey,
    mediaType: r.mediaType,
    sizeBytes: Number(r.sizeBytes),
    plainBytes: Number(r.plainBytes),
    sha256: r.sha256,
    status: r.status,
    createdAt: r.createdAt,
    finalizedAt: r.finalizedAt,
  };
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.media");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const status = sp.get("status") ?? "all";
    const period = sp.get("period") ?? "all";
    const owner = sp.get("owner");

    if (!(STATUS_FILTERS as readonly string[]).includes(status)) {
      return NextResponse.json(
        { error: "status invalide (all | pending | finalized)" },
        { status: 400 }
      );
    }
    if (!(period === "all" || period in PERIODS)) {
      return NextResponse.json(
        { error: "period invalide (24h | 7d | 30d | all)" },
        { status: 400 }
      );
    }
    if (owner !== null && (owner.length === 0 || owner.length > 200)) {
      return NextResponse.json({ error: "owner invalide (pubkey 1..200 caractères)" }, { status: 400 });
    }

    // ── conditions de BASE (partagées : liste, ancre du curseur) ───────────
    const baseParams: (string | number)[] = [];
    const statusCond = status === "pending" ? "AND m.status = 'pending'" : status === "finalized" ? "AND m.status = 'finalized'" : "";
    const sinceMs = period === "all" ? 0 : Date.now() - PERIODS[period];
    const periodCond = sinceMs > 0 ? "AND m.createdAt >= ?" : "";
    if (sinceMs > 0) baseParams.push(sinceMs);
    const ownerCond = owner ? "AND m.ownerPubkey = ?" : "";
    if (owner) baseParams.push(owner);
    const baseWhere = `WHERE 1=1 ${statusCond} ${periodCond} ${ownerCond}`;

    // ── totals GLOBAUX (hors filtres) — sous-requêtes scalaires ; SUM/COUNT
    //    → BigInt → Number(). pendingExpired24h = orphelins > 24 h. ────────
    const totalsRows = await db.$queryRawUnsafe<Array<RawMediaTotalsRow>>(
      `SELECT
         (SELECT COUNT(*) FROM Media) AS count,
         (SELECT COALESCE(SUM(sizeBytes), 0) FROM Media WHERE status = 'finalized') AS bytes,
         (SELECT COUNT(*) FROM Media WHERE status = 'pending') AS pendingCount,
         (SELECT COALESCE(SUM(sizeBytes), 0) FROM Media WHERE status = 'pending') AS pendingBytes,
         (SELECT COUNT(*) FROM Media WHERE status = 'pending' AND createdAt < ?) AS pendingExpired24h`,
      Date.now() - 24 * 3600_000
    );
    const t = totalsRows[0];
    const totals = {
      count: Number(t?.count ?? 0),
      bytes: Number(t?.bytes ?? 0),
      pending: {
        count: Number(t?.pendingCount ?? 0),
        bytes: Number(t?.pendingBytes ?? 0),
      },
      pendingExpired24h: Number(t?.pendingExpired24h ?? 0),
    };

    // ── cursor keyset (20/page) — garde de vue k="media" ────────────────────
    const cursorOr = decodeCursor(sp.get("cursor"));
    if (cursorOr === "malformed") {
      return NextResponse.json({ error: "cursor invalide" }, { status: 400 });
    }
    if (cursorOr && cursorOr.k !== "media") {
      return NextResponse.json(
        { error: "cursor invalide (émis sous un autre annuaire — repartez de la page 1)" },
        { status: 400 }
      );
    }

    // ancre : disparue (purgée) ou ne satisfaisant plus les filtres → restart
    let cursor: MediaCursor | null = cursorOr;
    let cursorReset = false;
    if (cursor) {
      const anchor = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n
         FROM Media m
         ${baseWhere} AND m.id = ?`,
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

    const rows = await db.$queryRawUnsafe<Array<RawMediaRow>>(
      `SELECT * FROM (
         SELECT m.id, m.objectKey, m.ownerPubkey, m.mediaType, m.sizeBytes, m.plainBytes,
                m.sha256, m.status, m.createdAt, m.finalizedAt
         FROM Media m
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
        ? encodeCursor({ k: "media", c: new Date(last.createdAt).getTime(), i: last.id })
        : null;

    return NextResponse.json({
      items: page.map(mapItem),
      nextCursor,
      cursorReset,
      totals,
      e2ee: true,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/media", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

export async function POST(req: NextRequest) {
  const done = trackApiRequest("internal.admin.media.purge");
  try {
    const gate = await requireAdmin(req, { minRole: "moderator", mutation: true });
    if (isDenied(gate)) return gate;
    const ctx = gate;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: "corps illisible (JSON attendu)" }, { status: 400 });
    }
    // Justification §6 — même convention que les autres mutations admin
    // (forme « CATÉGORIE: texte » ≥ 20 chars, validée serveur) → 422 sinon.
    const just = parseJustification(body);
    if (!just.ok) {
      return NextResponse.json({ error: just.error }, { status: 422 });
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (action !== "purge_media" && action !== "purge_pending_expired") {
      return NextResponse.json(
        { error: "action inconnue (purge_media | purge_pending_expired)" },
        { status: 400 }
      );
    }

    // ── purge_media : une ligne, id requis ──────────────────────────────────
    if (action === "purge_media") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id || id.length === 0 || id.length > 128) {
        return NextResponse.json({ error: "id requis pour purge_media (1..128 caractères)" }, { status: 400 });
      }
      const media = await db.media.findUnique({
        where: { id },
        select: { id: true, objectKey: true, ownerPubkey: true, mediaType: true, sizeBytes: true, plainBytes: true, status: true, createdAt: true, finalizedAt: true },
      });
      if (!media) {
        return NextResponse.json({ error: "Média introuvable" }, { status: 404 });
      }

      // Suppression de la LIGNE DB uniquement : media/storage.ts n'expose
      // QUE des URLs présignées PUT/GET (SigV4) — AUCUN helper de suppression
      // objet n'existe. L'objet ciphertext orphelin reste dans le bucket ;
      // la ligne disparue coupe l'accès (download-url exige la ligne).
      const fileDeleted = false;
      const fileDeleteMotif =
        "aucun helper de suppression objet dans media/storage.ts (presign PUT/GET uniquement) — la ligne DB est supprimée, l'objet ciphertext reste dans le bucket (GC hors périmètre)";
      await db.media.delete({ where: { id } });

      await db.moderationAction.create({
        data: {
          adminUserId: ctx.adminUserId,
          actorLabel: ctx.actorLabel,
          action: "purge",
          targetKind: "media",
          targetId: id,
          reason: just.value.formatted,
          reportIds: "[]",
          meta: JSON.stringify({
            mediaId: id,
            objectKey: media.objectKey,
            ownerPubkey: media.ownerPubkey,
            mediaType: media.mediaType,
            sizeBytes: media.sizeBytes,
            plainBytes: media.plainBytes,
            status: media.status,
            fileDeleted,
            fileDeleteMotif,
          }),
        },
      });
      await writeAdminAudit({
        actorId: ctx.adminUserId,
        actorRole: ctx.role,
        action: "purge",
        targetType: "media",
        targetId: id,
        before: { status: media.status, sizeBytes: media.sizeBytes, createdAt: media.createdAt, finalizedAt: media.finalizedAt },
        after: { deleted: 1, bytesFreed: media.sizeBytes, fileDeleted, fileDeleteMotif },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        justification: just.value.formatted,
      });

      return NextResponse.json({
        ok: true,
        affected: { deleted: 1, bytesFreed: media.sizeBytes, fileDeleted },
      });
    }

    // ── purge_pending_expired : lot de pendings jamais finalisés ───────────
    const maxAgeHoursRaw = body.maxAgeHours;
    let maxAgeHours = MAX_AGE_HOURS_DEFAULT;
    if (maxAgeHoursRaw !== undefined) {
      if (
        typeof maxAgeHoursRaw !== "number" ||
        !Number.isInteger(maxAgeHoursRaw) ||
        maxAgeHoursRaw < MAX_AGE_HOURS_MIN ||
        maxAgeHoursRaw > MAX_AGE_HOURS_MAX
      ) {
        return NextResponse.json(
          { error: `maxAgeHours invalide (entier ${MAX_AGE_HOURS_MIN}..${MAX_AGE_HOURS_MAX})` },
          { status: 400 }
        );
      }
      maxAgeHours = maxAgeHoursRaw;
    }
    const cutoff = new Date(Date.now() - maxAgeHours * 3600_000);
    const where = { status: "pending", createdAt: { lte: cutoff } };

    // octets libérés agrégés AVANT le delete (deleteMany ne renvoie qu'un
    // compte ; fenêtre de course documentée en tête de fichier).
    const preview = await db.media.aggregate({
      where,
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    const bytesFreed = preview._sum.sizeBytes ?? 0;

    const res = await db.media.deleteMany({ where });
    const deleted = res.count;

    await db.moderationAction.create({
      data: {
        adminUserId: ctx.adminUserId,
        actorLabel: ctx.actorLabel,
        action: "purge",
        targetKind: "media_batch",
        targetId: "batch",
        reason: just.value.formatted,
        reportIds: "[]",
        meta: JSON.stringify({
          maxAgeHours,
          cutoff: cutoff.toISOString(),
          deleted,
          bytesFreed,
        }),
      },
    });
    await writeAdminAudit({
      actorId: ctx.adminUserId,
      actorRole: ctx.role,
      action: "purge",
      targetType: "media_batch",
      targetId: "batch",
      after: { deleted, bytesFreed, maxAgeHours, cutoff: cutoff.toISOString() },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      justification: just.value.formatted,
    });

    return NextResponse.json({
      ok: true,
      affected: { deleted, bytesFreed },
    });
  } catch (e) {
    console.error("POST /api/internal/admin/media", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
