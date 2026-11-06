/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/internal/admin/backup-status — statut du dernier backup (Étape 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Endpoint interne dédié (directive Étape 5) : lit last-backup-status.json
 *  sur le VPS via fs.readFile — chemin configurable par BACKUP_STATUS_PATH,
 *  fallback « not configured » si absent. La même vue est agrégée dans
 *  /api/internal/admin/stats (métrique 4) — cet endpoint existe pour la
 *  vérification isolée de la métrique.
 *  Gate identique aux autres endpoints internes : token interne + session +
 *  acteur nominatif, rôle ≥ support (auditor → 403).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { trackApiRequest } from "@/lib/mbote/state-store";
import { isDenied, requireAdmin } from "@/lib/mbote/admin-auth";
import { readBackupStatus } from "@/lib/mbote/dashboard-stats";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const done = trackApiRequest("internal.admin.backupStatus");
  try {
    const gate = await requireAdmin(req, { minRole: "support" });
    if (isDenied(gate)) return gate;

    const backup = await readBackupStatus();
    return NextResponse.json({ backup });
  } catch (e) {
    console.error("GET /api/internal/admin/backup-status", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  } finally {
    done();
  }
}
