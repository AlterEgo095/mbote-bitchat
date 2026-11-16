// ─────────────────────────────────────────────────────────────────────────────
// Client HTTP interne vers l'app principale (mbote:3000) — ADM Étapes 3+4.
// INVARIANT ARCHITECTURE (docs/specs/ADMIN-RBAC.md §1) : cette app n'a PAS de
// client DB — TOUTE donnée passe par ces appels (réseau Docker interne en
// prod, localhost en dev sandbox).
//
// Chaque appel porte :
//   - `x-admin-internal`   : ADMIN_INTERNAL_TOKEN (identifie le panneau,
//                            JAMAIS un acteur — RBAC §8) ;
//   - `x-admin-session`    : token de session brut (le hash vit en DB côté
//                            app principale — jamais stocké ici) ;
//   - `x-admin-actor`      : AdminUser.id retourné par verify (cross-check
//                            serveur contre la session) ;
//   - `x-admin-csrf`       : sur mutation, jeton de la session ;
//   - `x-forwarded-for`    : IP client d'origine (rate-limit login par IP).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

export const ADMIN_COOKIE = "mbote_admin_session";

export function backendBase(): string {
  return process.env.BACKEND_INTERNAL_URL ?? "http://127.0.0.1:3000";
}

export interface InternalCallOptions {
  body?: unknown;
  sessionToken?: string | null;
  csrf?: string | null;
  actorId?: number | null;
  clientForwardedFor?: string | null;
  method?: "POST" | "GET";
}

export interface InternalCallResult {
  status: number;
  body: Record<string, unknown>;
}

export async function callBackend(path: string, opts: InternalCallOptions = {}): Promise<InternalCallResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.ADMIN_INTERNAL_TOKEN ?? "";
  if (token) headers["x-admin-internal"] = token;
  if (opts.sessionToken) headers["x-admin-session"] = opts.sessionToken;
  if (opts.csrf) headers["x-admin-csrf"] = opts.csrf;
  if (opts.actorId != null) headers["x-admin-actor"] = String(opts.actorId);
  if (opts.clientForwardedFor) headers["x-forwarded-for"] = opts.clientForwardedFor;

  const res = await fetch(`${backendBase()}${path}`, {
    // endpoints internes = POST (verify/logout/login/break-glass) ; les appels
    // avec session/csrf/actor sont des mutations ou validations authentifiées
    method: opts.method ??
      (opts.body !== undefined || opts.sessionToken || opts.csrf || opts.actorId != null ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * Chemin du panneau sous le domaine (Go-to-Market 2026-11 — obscurcissement).
 * ADMIN_BASE_PATH est l'équivalent RUNTIME de NEXT_PUBLIC_ADMIN_BASE_PATH
 * (build) — même valeur, injectée par le compose depuis le .env VPS. Vide =
 * racine (dev sandbox / sous-domaine dédié).
 * Le cookie de session est SCOPÉ à ce chemin : servi sous /console-xxxx/, il
 * n'est plus émis vers les routes publiques du même domaine (app principale).
 */
export const ADMIN_BASE_PATH: string = process.env.ADMIN_BASE_PATH || "";

/** Flags du cookie de session — HttpOnly, SameSite=Strict, Path=<base>/, Secure en prod. */
export function cookieFlags(): {
  httpOnly: true;
  sameSite: "strict";
  path: string;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "strict",
    path: ADMIN_BASE_PATH || "/",
    secure: process.env.NODE_ENV === "production",
  };
}

export function sessionTokenFrom(req: NextRequest): string | null {
  return req.cookies.get(ADMIN_COOKIE)?.value ?? null;
}

export interface PanelSession {
  adminUserId: number;
  role: string;
  email: string;
  csrfToken: string;
  sessionId: string;
  totpEnrolled: boolean;
}

/**
 * « Appel de vérification depuis le panneau » (directive Étape 4) : valide la
 * session auprès de l'app principale à CHAQUE requête authentifiée. Retourne
 * null si le cookie est absent ou si l'app principale répond 401.
 */
export async function verifyPanelSession(req: NextRequest): Promise<PanelSession | null> {
  const token = sessionTokenFrom(req);
  if (!token) return null;
  const r = await callBackend("/api/internal/admin/verify", {
    method: "POST",
    sessionToken: token,
    clientForwardedFor: req.headers.get("x-forwarded-for"),
  });
  if (r.status !== 200) return null;
  const b = r.body;
  if (typeof b.adminUserId !== "number" || typeof b.role !== "string") return null;
  return {
    adminUserId: b.adminUserId,
    role: b.role,
    email: typeof b.email === "string" ? b.email : "",
    csrfToken: typeof b.csrfToken === "string" ? b.csrfToken : "",
    sessionId: typeof b.sessionId === "string" ? b.sessionId : "",
    totpEnrolled: b.totpEnrolled === true,
  };
}

/** Version composant serveur de verifyPanelSession (via cookies() de next/headers). */
export async function getPanelSessionServer(): Promise<PanelSession | null> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  if (!token) return null;
  const r = await callBackend("/api/internal/admin/verify", { method: "POST", sessionToken: token });
  if (r.status !== 200) return null;
  const b = r.body;
  if (typeof b.adminUserId !== "number" || typeof b.role !== "string") return null;
  return {
    adminUserId: b.adminUserId,
    role: b.role,
    email: typeof b.email === "string" ? b.email : "",
    csrfToken: typeof b.csrfToken === "string" ? b.csrfToken : "",
    sessionId: typeof b.sessionId === "string" ? b.sessionId : "",
    totpEnrolled: b.totpEnrolled === true,
  };
}

/** Refus UNIFORME — même message que l'app principale (401 et 403). */
export function denied(status: 401 | 403): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status });
}
