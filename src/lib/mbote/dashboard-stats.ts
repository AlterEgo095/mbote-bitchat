/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  dashboard-stats — les 4 métriques du tableau de bord ADM (Étape 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Directive Étape 5 : « Le dashboard est un instrument de pilotage, pas une
 *  vitrine. 4 métriques, rien de plus. »
 *
 *   1. Utilisateurs actifs 24 h / 7 j — SQL DIRECTE (directive explicite,
 *      pas de cache à ce stade) : un User est « actif » dans une fenêtre s'il
 *      a un Post (FK authorId) OU une DirectMessage (senderKey/recipientKey
 *      == pubkey — pas de FK, boîte aux lettres aveugle) dans la fenêtre.
 *   2. Reports ouverts — COUNT(*) FROM Report WHERE handledById IS NULL
 *      (directive à la lettre ; un report clôturé reçoit toujours handledById).
 *   3. Uptime conteneur — process.uptime() de l'app principale, LA MÊME source
 *      que GET /api/stats (arbitrage : pas d'appel HTTP à soi-même — le
 *      health check Étape 2 continue de consommer /api/stats directement).
 *   4. Dernier backup — lecture fs de last-backup-status.json (chemin
 *      configurable BACKUP_STATUS_PATH), fallback « not configured » si
 *      absent ; aucun chemin serveur n'est exposé dans la réponse.
 *
 *  SEUILS (documentés ici = single source of truth ; l'alerting auto est
 *  l'Étape 8 — ici on ne fait que colorer) :
 *   - activeUsers 24 h : rouge 0 (réseau mort) · orange 1–4 · vert ≥ 5
 *   - openReports      : vert ≤ 10 · orange 11–50 · rouge > 50 (backlog)
 *   - uptime           : rouge < 1 h (crash-loop suspect) · orange 1–24 h
 *                        · vert ≥ 24 h (stable)
 *   - backup           : vert ok < 24 h · orange stale (> 24 h) ou non
 *                        configuré · rouge failed
 *
 *  AUCUNE donnée sensible dans les payloads : pas d'email, pas d'IP, pas de
 *  contenu de DM, pas de chemin serveur (directive Étape 5).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile } from "fs/promises";
import { db } from "@/lib/db";

/** Seuils de coloration — voir en-tête. Exportés pour les tests. */
export const DASHBOARD_THRESHOLDS = {
  activeUsers24h: { greenMin: 5, orangeMin: 1 },
  openReports: { greenMax: 10, orangeMax: 50 },
  uptimeHours: { greenMin: 24, orangeMin: 1 },
  backupFreshHours: 24,
} as const;

export type MetricColor = "green" | "orange" | "red";

export interface BackupStatusView {
  /** ok (frais) | stale (trop vieux) | failed | not-configured */
  state: "ok" | "stale" | "failed" | "not-configured";
  /** date ISO du dernier backup connu (null si non configuré) */
  at: string | null;
  /** âge en heures du dernier backup connu (arrondi 1 déc.) */
  ageHours: number | null;
  status: MetricColor;
  /** détail factuel court — JAMAIS de chemin serveur ni de contenu privé */
  detail: string;
}

/**
 * Lecture du statut de backup. Le fichier (écrit par le cron de backup VPS)
 * est un JSON { "state": "ok" | "failed", "at": "<ISO>" } — tout le reste est
 * toléré (champs manquants → dégradé) mais rien de plus n'est lu.
 */
export async function readBackupStatus(now = new Date()): Promise<BackupStatusView> {
  const path = process.env.BACKUP_STATUS_PATH;
  if (!path) {
    return {
      state: "not-configured",
      at: null,
      ageHours: null,
      status: "orange",
      detail: "BACKUP_STATUS_PATH non configuré",
    };
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // fallback directive : fichier absent/illisible = « not configured »
    return {
      state: "not-configured",
      at: null,
      ageHours: null,
      status: "orange",
      detail: "fichier de statut absent ou illisible",
    };
  }
  let parsed: { state?: unknown; at?: unknown };
  try {
    parsed = JSON.parse(raw) as { state?: unknown; at?: unknown };
  } catch {
    return {
      state: "not-configured",
      at: null,
      ageHours: null,
      status: "orange",
      detail: "fichier de statut illisible (JSON invalide)",
    };
  }
  const state = parsed.state === "ok" || parsed.state === "failed" ? parsed.state : null;
  const at = typeof parsed.at === "string" ? parsed.at : null;
  const atDate = at ? new Date(at) : null;
  const ageHours =
    atDate && !Number.isNaN(atDate.getTime())
      ? Math.round(((now.getTime() - atDate.getTime()) / 3600e3) * 10) / 10
      : null;

  if (state === "failed") {
    return { state: "failed", at, ageHours, status: "red", detail: "dernier backup en échec" };
  }
  if (state === "ok" && ageHours !== null && ageHours <= DASHBOARD_THRESHOLDS.backupFreshHours) {
    return { state: "ok", at, ageHours, status: "green", detail: "backup récent" };
  }
  return {
    state: "stale",
    at,
    ageHours,
    status: "orange",
    detail:
      ageHours !== null
        ? `dernier backup il y a ${ageHours} h (> seuil ${DASHBOARD_THRESHOLDS.backupFreshHours} h)`
        : "horodatage de backup absent ou invalide",
  };
}

export interface DashboardMetrics {
  generatedAt: string;
  activeUsers: {
    h24: number;
    d7: number;
    status: MetricColor;
    updatedAt: string;
  };
  openReports: { value: number; status: MetricColor; updatedAt: string };
  uptime: { seconds: number; status: MetricColor; updatedAt: string };
  backup: BackupStatusView & { updatedAt: string };
}

function colorForActiveUsers(h24: number): MetricColor {
  if (h24 >= DASHBOARD_THRESHOLDS.activeUsers24h.greenMin) return "green";
  if (h24 >= DASHBOARD_THRESHOLDS.activeUsers24h.orangeMin) return "orange";
  return "red";
}

function colorForOpenReports(n: number): MetricColor {
  if (n <= DASHBOARD_THRESHOLDS.openReports.greenMax) return "green";
  if (n <= DASHBOARD_THRESHOLDS.openReports.orangeMax) return "orange";
  return "red";
}

function colorForUptime(seconds: number): MetricColor {
  const hours = seconds / 3600;
  if (hours >= DASHBOARD_THRESHOLDS.uptimeHours.greenMin) return "green";
  if (hours >= DASHBOARD_THRESHOLDS.uptimeHours.orangeMin) return "orange";
  return "red";
}

/**
 * Compte SQL DIRECTE des utilisateurs actifs (directive Étape 5 — pas de
 * cache). Un User est actif s'il a un Post dans la fenêtre (FK authorId) ou
 * une DirectMessage où sa pubkey apparaît en sender/recipient (pas de FK —
 * boîte aux lettres aveugle E2EE : la correspondance se fait sur la pubkey).
 */
export async function countActiveUsers(sinceIso24h: Date, sinceIso7d: Date): Promise<{ h24: number; d7: number }> {
  const rows = await db.$queryRaw<{ h24: number; d7: number }[]>`
    SELECT
      (SELECT COUNT(DISTINCT u."id") FROM "User" u
        WHERE EXISTS (SELECT 1 FROM "Post" p
          WHERE p."authorId" = u."id" AND p."createdAt" >= ${sinceIso24h})
           OR EXISTS (SELECT 1 FROM "DirectMessage" d
          WHERE (d."senderKey" = u."pubkey" OR d."recipientKey" = u."pubkey")
            AND d."createdAt" >= ${sinceIso24h})
      ) AS h24,
      (SELECT COUNT(DISTINCT u."id") FROM "User" u
        WHERE EXISTS (SELECT 1 FROM "Post" p
          WHERE p."authorId" = u."id" AND p."createdAt" >= ${sinceIso7d})
           OR EXISTS (SELECT 1 FROM "DirectMessage" d
          WHERE (d."senderKey" = u."pubkey" OR d."recipientKey" = u."pubkey")
            AND d."createdAt" >= ${sinceIso7d})
      ) AS d7
  `;
  const row = rows[0];
  if (!row) return { h24: 0, d7: 0 };
  return { h24: Number(row.h24), d7: Number(row.d7) };
}

/** Assemble les 4 métriques (une seule évaluation d'horodatage par métrique). */
export async function computeDashboardMetrics(now = new Date()): Promise<DashboardMetrics> {
  const since24h = new Date(now.getTime() - 24 * 3600e3);
  const since7d = new Date(now.getTime() - 7 * 24 * 3600e3);

  const [active, openReports, backup] = await Promise.all([
    countActiveUsers(since24h, since7d),
    db.report.count({ where: { handledById: null } }), // directive : handledById IS NULL
    readBackupStatus(now),
  ]);
  const uptimeSeconds = Math.round(process.uptime());

  return {
    generatedAt: now.toISOString(),
    activeUsers: {
      h24: active.h24,
      d7: active.d7,
      status: colorForActiveUsers(active.h24),
      updatedAt: now.toISOString(),
    },
    openReports: {
      value: openReports,
      status: colorForOpenReports(openReports),
      updatedAt: now.toISOString(),
    },
    uptime: {
      seconds: uptimeSeconds,
      status: colorForUptime(uptimeSeconds),
      updatedAt: now.toISOString(),
    },
    backup: { ...backup, updatedAt: now.toISOString() },
  };
}
