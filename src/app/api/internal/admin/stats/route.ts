/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/stats — les 4 métriques du dashboard (ADM Étape 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Appelé par le panneau admin (BFF /api/dashboard) avec la CHAÎNE COMPLÈTE
 *  Étape 4 : token interne + session (x-admin-session) + acteur nominatif
 *  (X-Admin-Actor). Gate : requireAdmin({ minRole: "support" }) —
 *   - auditor → 403 (lecture seule sur l'audit UNIQUEMENT — directive : il
 *     n'a pas accès aux stats users) ;
 *   - support/moderator/super-admin → 200.
 *  Lecture seule → pas de CSRF (matrice §4 : x-admin-csrf exigé sur mutation
 *  uniquement). Réponse : 4 clés (activeUsers, openReports, uptime, backup) +
 *  generatedAt — AUCUNE donnée sensible (pas d'email, pas d'IP, pas de
 *  contenu de DM — directive Étape 5).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { computeDashboardMetrics } from "@/lib/mbote/dashboard-stats";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.stats");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const metrics = await computeDashboardMetrics();
    return NextResponse.json(metrics);
  } catch (e) {
    console.error("GET /api/internal/admin/stats", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
