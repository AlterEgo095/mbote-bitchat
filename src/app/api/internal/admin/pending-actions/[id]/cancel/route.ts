import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { cancelPendingAction } from "@/lib/mbote/pending-action";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/pending-actions/[id]/cancel — FOUR-EYES (É9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Annulation PAR LE DEMANDEUR UNIQUEMENT (directive : bouton « Annuler » si
 *  currentUser === requestedBy). AUCUNE mutation de cible ; l'audit trace
 *  `pendingaction_cancelled`. Une intention expirée répond 410 (elle ne peut
 *  plus être annulée non plus — le statut `expired` fait foi).
 *  Porte : super-admin (le demandeur est nécessairement super-admin).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.pending-actions.cancel");
  try {
    const gate = await requireAdmin(req, { minRole: "super-admin", mutation: true });
    if (isDenied(gate)) return gate;
    const ctx = gate;

    const { id } = await params;
    const actionId = Number(id);
    if (!Number.isInteger(actionId) || actionId <= 0) {
      return NextResponse.json({ error: "id invalide" }, { status: 400 });
    }

    const result = await cancelPendingAction({ ctx, actionId });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ pendingAction: result.pendingAction });
  } catch (e) {
    console.error("POST /api/internal/admin/pending-actions/[id]/cancel", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
