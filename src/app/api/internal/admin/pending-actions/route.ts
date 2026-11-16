import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { parseJustification } from "@/lib/mbote/justification";
import {
  PENDING_ACTION_TYPES,
  expireAllDue,
  listPendingActions,
  requestPendingAction,
  type PendingActionType,
} from "@/lib/mbote/pending-action";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  /api/internal/admin/pending-actions — FOUR-EYES (ADM Étape 9)
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET  — liste des intentions (page /pending-actions). Porte : moderator min
 *         (moderator + super-admin ; support/auditor → 403 — testé E9·RBAC).
 *         Le balayage paresseux marque `expired` les intentions échues (pas de
 *         cron — tranché : expiresAt est évalué aux points d'application).
 *  POST — créer une intention { actionType, targetId, category, justification }.
 *         Porte : SUPER-ADMIN UNIQUEMENT (tranché 2026-11-06 : directive É9 —
 *         matrice §4 #9-10 réalignée). actionType fermé à ban_user|purge_post :
 *         toute action disponible à un seul modérateur (warn, suspend, hide…)
 *         est REFUSÉE — le four-eyes est réservé à l'irréversible.
 *
 *  Zéro DELETE, zéro UPDATE direct : les statuts passent par
 *  /[id]/approve et /[id]/cancel (audités) — append-only des statuts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.pending-actions.list");
  try {
    const gate = await requireAdmin(req, { minRole: "moderator" });
    if (isDenied(gate)) return gate;
    const ctx = gate;

    const expired = await expireAllDue(); // paresseux, audité par ligne
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const items = await listPendingActions({
      ctx,
      viewerSessionId: ctx.sessionId,
      status: status ?? undefined,
    });
    return NextResponse.json({ items, expiredMarked: expired });
  } catch (e) {
    console.error("GET /api/internal/admin/pending-actions", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}

export async function POST(req: NextRequest) {
  const done = trackApiRequest("internal.admin.pending-actions.create");
  try {
    const gate = await requireAdmin(req, { minRole: "super-admin", mutation: true });
    if (isDenied(gate)) return gate;
    const ctx = gate;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: "corps illisible (JSON attendu)" }, { status: 400 });
    }
    const actionType = body.actionType as PendingActionType;
    if (!(PENDING_ACTION_TYPES as readonly string[]).includes(actionType)) {
      return NextResponse.json(
        {
          error:
            "actionType invalide — four-eyes réservé aux actions irréversibles (ban_user | purge_post | purge_dm_pair | purge_group_messages)",
        },
        { status: 400 }
      );
    }
    const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
    if (targetId.length === 0 || targetId.length > 200) {
      return NextResponse.json({ error: "targetId invalide (1..200 caractères)" }, { status: 400 });
    }
    const just = parseJustification(body);
    if (!just.ok) {
      return NextResponse.json({ error: just.error }, { status: 422 });
    }

    const result = await requestPendingAction({
      ctx,
      actionType,
      targetId,
      just: just.value,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(
      {
        pendingAction: {
          id: result.pendingAction.id,
          actionType,
          targetType: actionType === "ban_user" ? "user" : "post",
          targetId,
          status: result.pendingAction.status,
          expiresAt: result.pendingAction.expiresAt.toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("POST /api/internal/admin/pending-actions", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
