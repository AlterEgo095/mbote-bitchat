import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin, writeAdminAudit } from "@/lib/mbote/admin-auth";
import { parseJustification } from "@/lib/mbote/justification";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET  /api/internal/admin/infra — santé infrastructure (passerelles + push)
 *  POST /api/internal/admin/infra — purge des abonnements push désactivés
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET (minRole "support") — deux volets :
 *   - gateways : nœuds passerelle mesh↔internet (senderID, label, lastSeen,
 *     compteurs de paquets) — « une passerelle muette = un maillage qui
 *     meurt », ORDER BY lastSeen DESC, 50 max ;
 *   - pushSubs : abonnements Web Push (C1 — KNOCK sans contenu, E2EE
 *     oblige) : actifs / désactivés + 20 derniers. Le ENDPOINT (URL du
 *     push service) est TRONQUÉ à 80 chars et le userAgent à 120 : l'URL
 *     complète est une donnée personnelle (identifiant d'appareil auprès
 *     de FCM/Mozilla) ET un vecteur de push ciblé si elle fuit — le
 *     panneau n'a besoin que d'un préfixe pour diagnostiquer un doublon.
 *     Les clés Web Push (keysP256dh/keysAuth) ne sont JAMAIS renvoyées.
 *
 *  POST (minRole "moderator", mutation:true — CSRF requis) — action
 *  « purge_disabled_push_subs » : deleteMany des abonnements désactivés
 *  (disabledAt != null) depuis plus de maxAgeDays (défaut 30, borné
 *  1..365). Les lignes désactivées ne servent plus personne (410 Gone du
 *  push service ou unsubscribe signé) — leur volume mort alourdit les
 *  fan-outs. Réponse { ok, affected: { deleted } }.
 *
 *  JUSTIFICATION §6 : {category, justification} validé via
 *  parseJustification (« CATÉGORIE: texte » ≥ 20 chars) — 422 sinon.
 *  AUDIT : ModerationAction(action:"purge", targetKind:"push_subs",
 *  targetId:"batch") + writeAdminAudit(targetType:"push_subs") — hors
 *  transaction (deleteMany simple, rien d'autre à enrouler). 400 corps
 *  illisible / action inconnue / maxAgeDays hors bornes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const GATEWAYS_LIMIT = 50;
const PUSH_RECENT_LIMIT = 20;

/** Bornes du paramètre purge_disabled_push_subs.maxAgeDays. */
const MAX_AGE_DAYS_MIN = 1;
const MAX_AGE_DAYS_MAX = 365;
const MAX_AGE_DAYS_DEFAULT = 30;

/** Tronque (null-safé) — le marqueur « … » prouve qu'il y a eu coupe. */
function truncate(s: string | null, max: number): string | null {
  if (s === null) return null;
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.infra");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const [gateways, psActive, psDisabled, psRecent] = await Promise.all([
      db.gatewayNode.findMany({
        orderBy: { lastSeen: "desc" },
        take: GATEWAYS_LIMIT,
        select: { id: true, label: true, lastSeen: true, packetsIn: true, packetsOut: true },
      }),
      db.pushSubscription.count({ where: { disabledAt: null } }),
      db.pushSubscription.count({ where: { disabledAt: { not: null } } }),
      db.pushSubscription.findMany({
        orderBy: { createdAt: "desc" },
        take: PUSH_RECENT_LIMIT,
        select: {
          id: true,
          userId: true,
          endpoint: true,
          userAgent: true,
          createdAt: true,
          lastSeenAt: true,
          disabledAt: true,
        },
      }),
    ]);

    return NextResponse.json({
      gateways: gateways.map((g) => ({
        id: g.id,
        label: g.label,
        lastSeen: g.lastSeen,
        packetsIn: g.packetsIn,
        packetsOut: g.packetsOut,
      })),
      pushSubs: {
        active: psActive,
        disabled: psDisabled,
        recent: psRecent.map((p) => ({
          id: p.id,
          userId: p.userId,
          endpoint: truncate(p.endpoint, 80),
          userAgent: truncate(p.userAgent, 120),
          createdAt: p.createdAt,
          lastSeenAt: p.lastSeenAt,
          disabledAt: p.disabledAt,
        })),
      },
      e2ee: true,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/infra", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

export async function POST(req: NextRequest) {
  const done = trackApiRequest("internal.admin.infra.purge");
  try {
    const gate = await requireAdmin(req, { minRole: "moderator", mutation: true });
    if (isDenied(gate)) return gate;
    const ctx = gate;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: "corps illisible (JSON attendu)" }, { status: 400 });
    }
    // Justification §6 — même convention que les autres mutations admin.
    const just = parseJustification(body);
    if (!just.ok) {
      return NextResponse.json({ error: just.error }, { status: 422 });
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (action !== "purge_disabled_push_subs") {
      return NextResponse.json(
        { error: "action inconnue (purge_disabled_push_subs)" },
        { status: 400 }
      );
    }

    const maxAgeDaysRaw = body.maxAgeDays;
    let maxAgeDays = MAX_AGE_DAYS_DEFAULT;
    if (maxAgeDaysRaw !== undefined) {
      if (
        typeof maxAgeDaysRaw !== "number" ||
        !Number.isInteger(maxAgeDaysRaw) ||
        maxAgeDaysRaw < MAX_AGE_DAYS_MIN ||
        maxAgeDaysRaw > MAX_AGE_DAYS_MAX
      ) {
        return NextResponse.json(
          { error: `maxAgeDays invalide (entier ${MAX_AGE_DAYS_MIN}..${MAX_AGE_DAYS_MAX})` },
          { status: 400 }
        );
      }
      maxAgeDays = maxAgeDaysRaw;
    }

    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600_000);
    const res = await db.pushSubscription.deleteMany({
      where: { disabledAt: { not: null, lt: cutoff } },
    });
    const deleted = res.count;

    // audit hors transaction : deleteMany simple, rien d'autre à enrouler
    await db.moderationAction.create({
      data: {
        adminUserId: ctx.adminUserId,
        actorLabel: ctx.actorLabel,
        action: "purge",
        targetKind: "push_subs",
        targetId: "batch",
        reason: just.value.formatted,
        reportIds: "[]",
        meta: JSON.stringify({
          maxAgeDays,
          cutoff: cutoff.toISOString(),
          deleted,
        }),
      },
    });
    await writeAdminAudit({
      actorId: ctx.adminUserId,
      actorRole: ctx.role,
      action: "purge",
      targetType: "push_subs",
      targetId: "batch",
      after: { deleted, maxAgeDays, cutoff: cutoff.toISOString() },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      justification: just.value.formatted,
    });

    return NextResponse.json({
      ok: true,
      affected: { deleted },
    });
  } catch (e) {
    console.error("POST /api/internal/admin/infra", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
