import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { parseJustification } from "@/lib/mbote/justification";
import { applyUserUnsuspension, findModerationTarget } from "@/lib/mbote/user-moderation";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/users/[id]/unsuspend — levée de suspension (E7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  HORS directive littérale (« périmètre strict MVP : view/suspend/warn »),
 *  AJOUTÉ par arbitrage §13.5 : sans levée, une suspension 30d est
 *  irréversible pendant 30 jours — intenable en exploitation. La sémantique
 *  existait déjà (unsuspend, /api/moderation/action Étape 0) : la fiche
 *  l'expose, le backend E7 réutilise applyUserUnsuspension (même transaction).
 *  Rôle : moderator + justification §6 (comme toute mutation).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.users.unsuspend");
  try {
    const gate = await requireAdmin(req, { minRole: "moderator", mutation: true });
    if (isDenied(gate)) return gate;
    const ctx = gate;

    const { id } = await params;
    if (!id || id.length === 0 || id.length > 200) {
      return NextResponse.json({ error: "id invalide" }, { status: 400 });
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: "corps illisible (JSON attendu)" }, { status: 400 });
    }
    const just = parseJustification(body);
    if (!just.ok) {
      return NextResponse.json({ error: just.error }, { status: 422 });
    }

    const user = await findModerationTarget(id);
    if (!user) {
      return NextResponse.json({ error: "Utilisateur introuvable" }, { status: 404 });
    }

    const outcome = await applyUserUnsuspension({ user, ctx, just: just.value });
    return NextResponse.json({
      action: outcome.trace,
      affected: { user: outcome.user },
    });
  } catch (e) {
    console.error("POST /api/internal/admin/users/[id]/unsuspend", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
