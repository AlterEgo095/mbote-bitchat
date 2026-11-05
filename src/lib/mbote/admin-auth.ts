/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  admin-auth — authentification admin par SESSION (ADM Étape 0 — rupture)
 * ─────────────────────────────────────────────────────────────────────────────
 *  RUPTURE ADMIN_API_KEY (audit docs/proofs/ADM-audit-2026-11-05.md, R-1/R-2) :
 *   - les endpoints admin ne lisent PLUS `ADMIN_API_KEY` (aucune exception) ;
 *   - l'authentification = cookie de session opaque (AdminSession.id, cuid
 *     non devinable) portant l'identité `AdminUser.id` — traçable nominativement ;
 *   - `ADMIN_API_KEY` ne reste lu QUE par le CLI de purge
 *     (scripts/moderation-purge.ts) — secret machine, jamais stocké en DB,
 *     jamais renvoyé en HTTP ;
 *   - anti-CSRF : toute mutation exige le header `x-admin-csrf` égal au
 *     csrfToken de la session (comparaison timing-safe) ;
 *   - hiérarchie de rôles : system < auditor < support < moderator < super-admin
 *     (matrice complète : docs/ADMIN-RBAC.md — Étape 1/4).
 *
 *  Entre l'Étape 0 et l'Étape 3 (login + TOTP), la seule façon de créer une
 *  session est l'outil DEV `scripts/admin-session.ts` (refusé en production) :
 *  la surface admin API est donc FERMÉE aux humains en prod — CLI seulement.
 *  C'est un retrait de capacité volontaire (fail-safe), pas une régression.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";

export const ADMIN_SESSION_COOKIE = "mbote_admin_session";
export const ADMIN_CSRF_HEADER = "x-admin-csrf";

/** Hiérarchie des rôles (le pseudo-user `system` ne passe JAMAIS requireAdmin). */
const ROLE_LEVEL: Record<string, number> = {
  system: 0,
  auditor: 1,
  support: 2,
  moderator: 3,
  "super-admin": 4,
};

export function roleAtLeast(role: string, min: string): boolean {
  return (ROLE_LEVEL[role] ?? -1) >= (ROLE_LEVEL[min] ?? 99);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Comparaison timing-safe de deux chaînes (via SHA-256, longueur fixe). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export interface AdminContext {
  sessionId: string;
  adminUserId: number;
  role: string;
  csrfToken: string;
  /** label d'acteur stocké dans ModerationAction — JAMAIS un secret */
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Résout la session admin du cookie. Retourne null si : cookie absent,
 * session inconnue, révoquée, expirée, ou admin désactivé.
 * Le cookie porte l'ID de session (cuid) — risque « fuite DB ⇒ sessions
 * actives » accepté (R-7 de l'audit) avec TTL courts + CF Access en amont.
 */
export async function getAdminSession(req: NextRequest): Promise<AdminContext | null> {
  const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.adminSession.findUnique({
    where: { id: token },
    include: { adminUser: { select: { id: true, role: true, disabledAt: true } } },
  });
  if (!session || session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (session.adminUser.disabledAt) return null;
  if (session.adminUser.role === "system") return null; // le CLI ne passe pas par HTTP

  // lastSeenAt (fire-and-forget — jamais bloquant pour la requête)
  void db.adminSession
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return {
    sessionId: session.id,
    adminUserId: session.adminUserId,
    role: session.adminUser.role,
    csrfToken: session.csrfToken,
    actorLabel: `admin-${session.adminUserId}`,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  };
}

export type AdminGate = AdminContext | NextResponse;

/**
 * Garde des endpoints admin (remplace `adminGuard` basé clé).
 * - pas/mauvaise session           → 401 uniforme
 * - rôle insuffisant               → 403
 * - mutation sans CSRF valide      → 403
 */
export async function requireAdmin(
  req: NextRequest,
  opts: { minRole?: string; mutation?: boolean } = {}
): Promise<AdminGate> {
  const ctx = await getAdminSession(req);
  if (!ctx) {
    return NextResponse.json({ error: "Session admin requise" }, { status: 401 });
  }
  if (!roleAtLeast(ctx.role, opts.minRole ?? "moderator")) {
    return NextResponse.json({ error: "Rôle insuffisant" }, { status: 403 });
  }
  if (opts.mutation) {
    const csrf = req.headers.get(ADMIN_CSRF_HEADER);
    if (!csrf || !safeEqual(csrf, ctx.csrfToken)) {
      return NextResponse.json({ error: "Jeton CSRF absent ou invalide" }, { status: 403 });
    }
  }
  return ctx;
}

/** Le gate est-il une erreur (NextResponse) plutôt qu'un contexte ? */
export function isDenied(gate: AdminGate): gate is NextResponse {
  return gate instanceof NextResponse;
}

/**
 * Crée une session admin (cookie opaque = AdminSession.id). Utilisé par le
 * login (Étape 3) et par l'outil DEV de bootstrap. Le hash du mot de passe et
 * le TOTP sont vérifiés PAR L'APPELANT (Étape 3).
 */
export async function createAdminSession(
  adminUserId: number,
  meta: { ip?: string | null; userAgent?: string | null; ttlMs?: number } = {}
): Promise<{ sessionId: string; csrfToken: string; expiresAt: Date }> {
  const csrfToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (meta.ttlMs ?? 8 * 3600_000));
  const session = await db.adminSession.create({
    data: {
      adminUserId,
      csrfToken,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      expiresAt,
    },
  });
  return { sessionId: session.id, csrfToken, expiresAt };
}

/** Écriture d'une ligne AdminAudit (append-only — triggers SQLite en DB). */
export interface AdminAuditEntry {
  actorId: number;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  justification?: string | null;
  /** écriture transactionnelle (même tx que l'action auditée) */
  tx?: Parameters<Parameters<typeof db.$transaction>[0]>[0];
}

export async function writeAdminAudit(e: AdminAuditEntry): Promise<void> {
  const client = e.tx ?? db;
  await client.adminAudit.create({
    data: {
      actorId: e.actorId,
      actorRole: e.actorRole,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      beforeJson: e.before === undefined ? null : JSON.stringify(e.before),
      afterJson: e.after === undefined ? null : JSON.stringify(e.after),
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      justification: e.justification ?? null,
    },
  });
}

/** Le pseudo-user `system` (seed migration 0004 — id 1) : acteur du CLI. */
export async function getSystemActor(): Promise<{ id: number; role: string }> {
  const system = await db.adminUser.findFirst({ where: { role: "system" }, select: { id: true, role: true } });
  if (!system) throw new Error("SYSTEM_ACTOR_MISSING (migration 0004 non appliquée ?)");
  return system;
}
