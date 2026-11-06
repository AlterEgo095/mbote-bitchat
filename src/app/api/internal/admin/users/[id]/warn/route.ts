import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { parseJustification } from "@/lib/mbote/justification";
import { applyUserWarning, findModerationTarget } from "@/lib/mbote/user-moderation";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/users/[id]/warn — avertissement (ADM Étape 7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 7 : « Warn (1 modérateur) » — rôle minimum MODERATOR sur
 *  les endpoints E7 (arbitrage §13.1 : la matrice §4 v1.0 disait warn=support ;
 *  la directive explicite prime → moderator ici. L'endpoint legacy
 *  /api/moderation/action conserve warn=support — harmonisation Étape 8+).
 *
 *  Corps : { category, justification } — forme §6 (parseJustification, 422 si
 *  invalide). Sémantique = applyUserWarning (user-moderation.ts) : UserWarning
 *  (notification profil utilisateur) + reports ouverts clos + ModerationAction
 *  + AdminAudit, UNE transaction.
 *
 *  AUCUNE route ban (Étape 9 four-eyes) — arbitrage §13.9.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.users.warn");
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

    const outcome = await applyUserWarning({ user, ctx, just: just.value });
    return NextResponse.json({
      action: outcome.trace,
      affected: {
        user: outcome.user,
        reportsClosed: outcome.reportsClosed,
        warningIssued: true,
      },
    });
  } catch (e) {
    console.error("POST /api/internal/admin/users/[id]/warn", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
