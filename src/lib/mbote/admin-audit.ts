/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  admin-audit — filtres + CSV partagés Étape 8 (list / export)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Un seul cerveau pour la validation des filtres (liste ET export — l'export
 *  doit obéir aux MÊMES règles que la liste qu'il duplique) et pour la
 *  sérialisation CSV (RFC 4180 — arbitrage §14.4 : pas de BOM, contenu
 *  parsable ; sans beforeJson/afterJson — la liste reste lisible).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Prisma } from "@prisma/client";

export const PERIODS: Record<string, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

/** Limite stricte de la plage custom (from/to) — garde anti-scan. */
export const CUSTOM_RANGE_MAX_MS = 366 * 24 * 3600_000;

/** Directive Étape 8 : 10 000 lignes max par export (message clair si dépassé). */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

export interface AuditFilters {
  actorId?: number;
  action?: string;
  targetType?: string;
  targetTypeId?: string;
  targetIdContains?: string;
  fromMs?: number;
  toMs?: number;
  sinceMs?: number;
}

export function auditFiltersFrom(searchParams: URLSearchParams): AuditFilters | { error: string } {
  const out: AuditFilters = {};

  const actorRaw = searchParams.get("actor");
  if (actorRaw) {
    const n = Number(actorRaw);
    if (!Number.isInteger(n) || n <= 0) return { error: "actor invalide (entier > 0)" };
    out.actorId = n;
  }

  const action = searchParams.get("action");
  if (action) {
    if (action.length > 64) return { error: "action invalide" };
    out.action = action;
  }

  const targetType = searchParams.get("targetType");
  if (targetType) {
    if (targetType.length > 32) return { error: "targetType invalide" };
    out.targetType = targetType;
  }

  // Recherche par cible : « type:id » → égalité double ; sinon sous-chaîne de
  // targetId (ex. user:123 est couvert par type:id ; un cuid partiel par
  // contains). Directive Étape 8 : « recherche par targetId (ex. user:123) ».
  const target = searchParams.get("target");
  if (target) {
    if (target.length > 200) return { error: "target invalide" };
    const colon = target.indexOf(":");
    if (colon > 0 && colon < 33) {
      out.targetType = target.slice(0, colon);
      out.targetTypeId = target.slice(colon + 1);
      if (!out.targetTypeId) return { error: "target invalide (type:id — id vide)" };
    } else {
      out.targetIdContains = target;
    }
  }

  // Période : since (bornes nommées) OU from/to (plage custom) — from/to PRIME
  // (arbitrage §14.6 : la plage explicite est plus précise que la borne nommée).
  const since = searchParams.get("since");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from || to) {
    if (since) return { error: "since et from/to sont mutuellement exclusifs" };
    const fromMs = from ? Date.parse(from) : undefined;
    const toMs = to ? Date.parse(to) : undefined;
    if (from && Number.isNaN(fromMs)) return { error: "from invalide (date ISO)" };
    if (to && Number.isNaN(toMs)) return { error: "to invalide (date ISO)" };
    if (fromMs !== undefined && toMs !== undefined && toMs < fromMs) {
      return { error: "plage invalide (to < from)" };
    }
    if (
      fromMs !== undefined && toMs !== undefined &&
      toMs - fromMs > CUSTOM_RANGE_MAX_MS
    ) {
      return { error: "plage trop large (> 366 jours)" };
    }
    out.fromMs = fromMs;
    out.toMs = toMs;
  } else if (since && since !== "all") {
    if (!(since in PERIODS)) return { error: "since invalide (24h | 7d | 30d | all)" };
    out.sinceMs = Date.now() - PERIODS[since];
  }

  return out;
}

export function auditWhereFrom(f: AuditFilters): Prisma.AdminAuditWhereInput {
  const where: Prisma.AdminAuditWhereInput = {};
  if (f.actorId !== undefined) where.actorId = f.actorId;
  if (f.action) where.action = f.action;
  if (f.targetType && f.targetTypeId) {
    where.targetType = f.targetType;
    where.targetId = f.targetTypeId;
  } else if (f.targetType) {
    where.targetType = f.targetType;
  } else if (f.targetIdContains) {
    where.targetId = { contains: f.targetIdContains };
  }
  const created: Prisma.DateTimeFilter = {};
  if (f.sinceMs !== undefined) created.gte = new Date(f.sinceMs);
  if (f.fromMs !== undefined) created.gte = new Date(f.fromMs);
  if (f.toMs !== undefined) created.lte = new Date(f.toMs);
  if (Object.keys(created).length > 0) where.createdAt = created;
  return where;
}

/** Échappement RFC 4180 : guillemets doublés, champ quoté si séparateur/quote/retour. */
export function csvField(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\r\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Colonnes export (directive) : SANS beforeJson/afterJson (arbitrage §14.2). */
export const AUDIT_EXPORT_HEADERS = [
  "timestamp",
  "acteur",
  "role",
  "action",
  "targetType",
  "targetId",
  "justification",
] as const;

export interface AuditExportRow {
  createdAt: Date;
  actorEmail: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  justification: string | null;
}

export function buildAuditCsv(rows: AuditExportRow[]): string {
  const lines: string[] = [AUDIT_EXPORT_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt.toISOString(),
        r.actorEmail,
        r.actorRole,
        r.action,
        r.targetType,
        r.targetId,
        r.justification ?? "",
      ]
        .map(csvField)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}
