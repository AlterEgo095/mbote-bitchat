import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { requireAdmin, isDenied } from "@/lib/mbote/admin-auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/audit/[id] — détail d'une ligne d'audit (ADM É8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 8 : fiche /audit/[id] — TOUS les champs : actorId,
 *  actorRole, action, targetType, targetId, beforeJson, afterJson, ip,
 *  userAgent, justification, createdAt (+ email de l'acteur pour l'affichage).
 *
 *  beforeJson/afterJson sont renvoyés BRUTS (strings JSON) — le pretty-print
 *  vit côté UI (accordéon replié par défaut, <details>). LECTURE SEULE :
 *  même porte exactRoles que la liste (arbitrage §14.1).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.audit.detail");
  try {
    const gate = await requireAdmin(req, { exactRoles: ["auditor", "super-admin"] });
    if (isDenied(gate)) return gate;

    const { id: idRaw } = await ctx.params;
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id invalide" }, { status: 400 });
    }

    const row = await db.adminAudit.findUnique({
      where: { id },
      include: { actor: { select: { email: true, role: true } } },
    });
    if (!row) {
      return NextResponse.json({ error: "Entrée d'audit inconnue" }, { status: 404 });
    }

    return NextResponse.json({
      id: row.id,
      createdAt: row.createdAt,
      actorId: row.actorId,
      actorEmail: row.actor.email,
      actorRole: row.actorRole,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      beforeJson: row.beforeJson,
      afterJson: row.afterJson,
      ip: row.ip,
      userAgent: row.userAgent,
      justification: row.justification,
    });
  } catch (e) {
    console.error("GET /api/internal/admin/audit/[id]", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
