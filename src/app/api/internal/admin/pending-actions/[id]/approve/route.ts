import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { approvePendingAction } from "@/lib/mbote/pending-action";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/pending-actions/[id]/approve — FOUR-EYES (É9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Approbation PAR UN SECOND ADMIN DISTINCT (garde double : id ≠ demandeur ET
 *  session ≠ session du demandeur) → EXÉCUTION IMMÉDIATE de la vraie action
 *  (ban | purge) dans UNE transaction, auditée (cycle = 2 lignes AdminAudit :
 *  pendingaction_created + ban|purge).
 *
 *  Porte : super-admin (tranché 2026-11-06, directive É9). Refus :
 *    403 auto-approbation (id ou session) · 410 expirée (> 1 h) ·
 *    409 déjà traitée · 404 inconnue.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.pending-actions.approve");
  try {
    const gate = await requireAdmin(req, { minRole: "super-admin", mutation: true });
    if (isDenied(gate)) return gate;
    const ctx = gate;

    const { id } = await params;
    const actionId = Number(id);
    if (!Number.isInteger(actionId) || actionId <= 0) {
      return NextResponse.json({ error: "id invalide" }, { status: 400 });
    }

    const result = await approvePendingAction({ ctx, actionId });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ executed: result.executed });
  } catch (e) {
    console.error("POST /api/internal/admin/pending-actions/[id]/approve", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
