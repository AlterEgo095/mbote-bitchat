import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { requireAdmin, isDenied } from "@/lib/mbote/admin-auth";
import {
  AUDIT_EXPORT_MAX_ROWS,
  auditFiltersFrom,
  auditWhereFrom,
  buildAuditCsv,
} from "@/lib/mbote/admin-audit";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/audit/export.csv — export CSV du journal (ADM É8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 8 : bouton « Exporter CSV » — téléchargement DIRECT via
 *  Content-Disposition: attachment. Mêmes filtres que la liste (un seul
 *  cerveau : auditFiltersFrom), MÊME porte exactRoles (arbitrage §14.1).
 *
 *  Colonnes : timestamp ISO, acteur (email), rôle, action, targetType,
 *  targetId, justification — SANS beforeJson/afterJson (trop volumineux, la
 *  liste doit rester lisible — arbitrage §14.2).
 *
 *  LIMITE : 10 000 lignes max par export — COUNT préalable ; dépassé → 422
 *  avec message clair (affiner les filtres). Jamais de troncature silencieuse
 *  (un export tronqué serait une preuve incomplète).
 *
 *  FORMAT : RFC 4180 strict (guillemets doublés, CRLF), charset=utf-8, PAS de
 *  BOM (arbitrage §14.4 — parsable automatisable ; Excel lit l'UTF-8 déclaré).
 *
 *  LECTURE SEULE : GET uniquement — l'export n'écrit RIEN (pas même une
 *  ligne d'audit : lire n'est pas une action modératoire).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.audit.export");
  try {
    const gate = await requireAdmin(req, { exactRoles: ["auditor", "super-admin"] });
    if (isDenied(gate)) return gate;

    const sp = req.nextUrl.searchParams;
    const filtersOr = auditFiltersFrom(sp);
    if ("error" in filtersOr) {
      return NextResponse.json({ error: filtersOr.error }, { status: 400 });
    }
    const where = auditWhereFrom(filtersOr);

    const total = await db.adminAudit.count({ where });
    if (total > AUDIT_EXPORT_MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Export trop volumineux : ${total} lignes (limite ${AUDIT_EXPORT_MAX_ROWS}) — affine les filtres (acteur, action, targetType, période).`,
        },
        { status: 422 }
      );
    }

    const rows = await db.adminAudit.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        createdAt: true,
        action: true,
        targetType: true,
        targetId: true,
        justification: true,
        actorRole: true,
        actor: { select: { email: true } },
      },
    });

    const csv = buildAuditCsv(
      rows.map((r) => ({
        createdAt: r.createdAt,
        actorEmail: r.actor.email,
        actorRole: r.actorRole,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        justification: r.justification,
      }))
    );

    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-${stamp}.csv"`,
        "Cache-Control": "no-store",
        "X-Export-Rows": String(rows.length),
      },
    });
  } catch (e) {
    console.error("GET /api/internal/admin/audit/export.csv", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
