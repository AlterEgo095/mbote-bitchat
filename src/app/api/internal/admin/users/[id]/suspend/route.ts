import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { parseJustification } from "@/lib/mbote/justification";
import {
  E7_SUSPEND_DURATIONS,
  applyUserSuspension,
  findModerationTarget,
} from "@/lib/mbote/user-moderation";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST /api/internal/admin/users/[id]/suspend — suspension temp. (E7)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 7 : « Suspend temporaire (1 modérateur, dropdown
 *  24h/7j/30j) : bloque la publication de posts, DM reste possible (E2EE
 *  préservée), sessions révoquées si applicable (pas de sessions utilisateur
 *  aujourd'hui) ».
 *
 *  Corps : { duration: "24h" | "7d" | "30d", category, justification } —
 *  422 justification invalide, 400 duration invalide (arbitrage §13.3 : les
 *  endpoints E7 n'acceptent PAS "indefinite" — la levée passe par unsuspend ;
 *  l'endpoint legacy /api/moderation/action conserve indefinite).
 *
 *  Sémantique = applyUserSuspension (user-moderation.ts) : suspension active
 *  tant que suspendedUntil > now (évaluation paresseuse — publication 403,
 *  feed exclut, DM POSSIBLE), reports ouverts clos, ModerationAction +
 *  AdminAudit, UNE transaction. Révocation de sessions : NO-OP documenté
 *  (§13.4 — aucune session utilisateur : identité = paire de clés).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const done = trackApiRequest("internal.admin.users.suspend");
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
    const duration = typeof body.duration === "string" ? body.duration : "";
    if (!(E7_SUSPEND_DURATIONS as readonly string[]).includes(duration)) {
      return NextResponse.json(
        { error: `duration invalide (valeurs : ${E7_SUSPEND_DURATIONS.join(", ")})` },
        { status: 400 }
      );
    }

    const user = await findModerationTarget(id);
    if (!user) {
      return NextResponse.json({ error: "Utilisateur introuvable" }, { status: 404 });
    }

    const outcome = await applyUserSuspension({ user, ctx, just: just.value }, duration);
    return NextResponse.json({
      action: outcome.trace,
      affected: {
        user: outcome.user,
        reportsClosed: outcome.reportsClosed,
        duration,
        sessionsRevoked: 0, // no-op documenté (§13.4) — aucune session user
      },
    });
  } catch (e) {
    console.error("POST /api/internal/admin/users/[id]/suspend", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
