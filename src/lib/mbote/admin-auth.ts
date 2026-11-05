/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  admin-auth — authentification admin par SESSION (ADM Étapes 0 + 3 + 4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  RUPTURE ADMIN_API_KEY (Étape 0 — docs/proofs/ADM-rupture.md) : les
 *  endpoints admin ne lisent PLUS `ADMIN_API_KEY` ; l'acteur est toujours
 *  `AdminUser.id` (traçable), l'audit est append-only (triggers SQLite).
 *
 *  ÉTAPE 3 (directive « auth + RBAC ») — durcissement de la session :
 *   - le cookie porte un token ALÉATOIRE 32 octets ; SEUL SON HASH SHA-256
 *     vit en DB (`AdminSession.tokenHash`) — jamais le token en clair ;
 *   - timeout IDLE 30 min (`lastSeenAt` mis à jour à chaque requête validée)
 *     + TTL absolu 8 h (`expiresAt`) — le plus court des deux gagne ;
 *   - révocation : logout, break-glass (toutes les sessions du user),
 *     admin désactivé, idle-expiry (marquée `revokedReason`).
 *
 *  ÉTAPE 4 — RBAC + double contrôle sur /api/moderation/* :
 *   - `requireAdmin()` exige EN PLUS le token interne (`x-admin-internal`,
 *     timing-safe — seul le panneau admin appelle ces endpoints) ;
 *   - `X-Admin-Actor` (obligatoire) doit correspondre à la session validée —
 *     AUCUNE action possible avec le token interne SEUL (directive explicite) ;
 *   - 401 (session absente/invalide) et 403 (rôle insuffisant / CSRF invalide)
 *     renvoient le MÊME message `unauthorized` — aucune fuite sur la couche
 *     qui a refusé.
 *
 *  Hiérarchie des rôles : system(0) < auditor(1) < support(2) < moderator(3)
 *  < super-admin(4). Le pseudo-user `system` ne passe JAMAIS par HTTP.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  ACTOR_HEADER,
  CSRF_HEADER,
  SESSION_TOKEN_HEADER,
  clientIp,
  internalTokenOk,
  safeEqual,
} from "@/lib/mbote/admin-internal";

export const ADMIN_SESSION_COOKIE = "mbote_admin_session";
export const ADMIN_CSRF_HEADER = CSRF_HEADER;
export const ADMIN_ACTOR_HEADER = ACTOR_HEADER;

/** Timeout idle — directive Étape 3 : 30 min d'inactivité = session morte. */
export const SESSION_IDLE_MS = 30 * 60_000;
/** TTL absolu — directive Étape 3 : 8 h maximum. */
export const SESSION_TTL_MS = 8 * 3600_000;

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

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface AdminContext {
  sessionId: string;
  adminUserId: number;
  role: string;
  email: string;
  csrfToken: string;
  /** label d'acteur stocké dans ModerationAction — JAMAIS un secret */
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
}

/** Réponse de refus UNIFORME — même message pour 401 et 403 (anti-fuite). */
function denied(status: 401 | 403): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status });
}

/**
 * Résout une session par son token (cookie ou header interne). Retourne null
 * si : token absent, hash inconnu, révoquée, idle-expirée (30 min), absolu-
 * expirée (8 h), admin désactivé, ou pseudo-user `system` (CLI uniquement).
 */
export async function getSessionFromToken(rawToken: string | null | undefined): Promise<AdminContext | null> {
  if (!rawToken) return null;
  const session = await db.adminSession.findUnique({
    where: { tokenHash: sha256hex(rawToken) },
    include: { adminUser: { select: { id: true, email: true, role: true, disabledAt: true } } },
  });
  if (!session || session.revokedAt) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) return null; // TTL absolu 8 h
  if (now - session.lastSeenAt.getTime() > SESSION_IDLE_MS) {
    // idle-expiry : révocation paresseuse TRACÉE (preuve : revokedReason)
    await db.adminSession
      .update({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "idle-timeout" },
      })
      .catch(() => undefined);
    return null;
  }
  if (session.adminUser.disabledAt) return null;
  if (session.adminUser.role === "system") return null; // le CLI ne passe pas par HTTP

  // lastSeenAt — mis à jour à CHAQUE requête validée (directive Étape 3)
  await db.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });

  return {
    sessionId: session.id,
    adminUserId: session.adminUserId,
    role: session.adminUser.role,
    email: session.adminUser.email,
    csrfToken: session.csrfToken,
    actorLabel: `admin-${session.adminUserId}`,
    ip: null,
    userAgent: null,
  };
}

/**
 * Session admin depuis la requête : cookie `mbote_admin_session` (navigateur →
 * panneau) OU header `x-admin-session` (panneau → app principale, endpoints
 * internes). Les métadonnées ip/userAgent viennent de la requête courante.
 */
export async function getSessionFromCookie(req: NextRequest): Promise<AdminContext | null> {
  const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value ?? req.headers.get(SESSION_TOKEN_HEADER);
  const ctx = await getSessionFromToken(token);
  if (!ctx) return null;
  ctx.ip = req.headers.get("x-forwarded-for") ?? clientIp(req);
  ctx.userAgent = req.headers.get("user-agent");
  return ctx;
}

/** Alias historique (Étape 0) — conservé pour les appels existants. */
export const getAdminSession = getSessionFromCookie;

export type AdminGate = AdminContext | NextResponse;

/**
 * Garde des endpoints admin (session + token interne + rôles + CSRF).
 * Ordre des contrôles — TOUS renvoient le même message :
 *   1. token interne (x-admin-internal)            → 401
 *   2. session (cookie/header) valide et vivante   → 401
 *   3. X-Admin-Actor présent et == session         → 401 (obligatoire : le
 *      token interne SEUL ne peut RIEN faire — directive Étape 4)
 *   4. mutation sans CSRF valide                   → 403
 *   5. rôle insuffisant                            → 403
 */
export async function requireAdmin(
  req: NextRequest,
  opts: { minRole?: string; mutation?: boolean } = {}
): Promise<AdminGate> {
  // 1. double contrôle : seul le panneau admin (token interne) parle ici
  if (!internalTokenOk(req)) return denied(401);

  // 2. session
  const ctx = await getSessionFromCookie(req);
  if (!ctx) return denied(401);

  // 3. acteur nominatif — croisé avec la session (jamais un actor forgé)
  const actorHdr = req.headers.get(ADMIN_ACTOR_HEADER);
  if (!actorHdr || Number(actorHdr) !== ctx.adminUserId) return denied(401);

  // 4. CSRF sur toute mutation
  if (opts.mutation) {
    const csrf = req.headers.get(ADMIN_CSRF_HEADER);
    if (!csrf || !safeEqual(csrf, ctx.csrfToken)) return denied(403);
  }

  // 5. rôle
  if (!roleAtLeast(ctx.role, opts.minRole ?? "moderator")) return denied(403);

  return ctx;
}

/** Le gate est-il une erreur (NextResponse) plutôt qu'un contexte ? */
export function isDenied(gate: AdminGate): gate is NextResponse {
  return gate instanceof NextResponse;
}

/**
 * Crée une session admin : token aléatoire 32 octets (base64url) pour le
 * cookie, SEUL SON HASH SHA-256 en DB. Utilisé par le login et le break-glass
 * (Étape 3) et par l'outil DEV de session (tests).
 */
export async function createAdminSession(
  adminUserId: number,
  meta: { ip?: string | null; userAgent?: string | null; ttlMs?: number } = {}
): Promise<{ sessionId: string; sessionToken: string; csrfToken: string; expiresAt: Date }> {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (meta.ttlMs ?? SESSION_TTL_MS));
  const session = await db.adminSession.create({
    data: {
      adminUserId,
      tokenHash: sha256hex(sessionToken),
      csrfToken,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      expiresAt,
    },
  });
  return { sessionId: session.id, sessionToken, csrfToken, expiresAt };
}

/** Révoque une session (raison tracée) — logout / break-glass / disable. */
export async function revokeAdminSession(sessionId: string, reason: string): Promise<void> {
  await db.adminSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** Révoque TOUTES les sessions actives d'un admin (break-glass / disable). */
export async function revokeAllAdminSessions(adminUserId: number, reason: string): Promise<number> {
  const res = await db.adminSession.updateMany({
    where: { adminUserId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return res.count;
}

/**
 * Écriture d'une ligne AdminAudit (append-only — triggers SQLite en DB).
 * Signature directive Étape 4 : writeAdminAudit({actorId, action, targetType,
 * targetId, beforeJson, afterJson, justification}) — `before`/`after` acceptent
 * objets (sérialisés ici) ou strings JSON brutes.
 */
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

function asJson(v: unknown): string | null {
  if (v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
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
      beforeJson: asJson(e.before),
      afterJson: asJson(e.after),
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
