/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  admin-internal — garde du token interne mbote↔admin (ADM Étape 4, RBAC §8)
 * ─────────────────────────────────────────────────────────────────────────────
 *  `ADMIN_INTERNAL_TOKEN` (32 octets hex) identifie COLLECTIVEMENT « le
 *  panneau admin » — il ne ressuscite PAS ADMIN_API_KEY (portée réseau
 *  interne, endpoints /api/internal/admin/* + double contrôle /api/moderation/*).
 *  Il n'identifie JAMAIS un acteur : l'acteur reste AdminUser.id, validé par la
 *  SESSION (header X-Admin-Actor en cross-check — directive Étape 4).
 *
 *  Garanties :
 *   - comparaison timing-safe (via SHA-256, longueur fixe) ;
 *   - fail-closed : token absent de l'env → TOUT refusé (pas de mode dégradé) ;
 *   - jamais en DB, jamais en réponse HTTP, jamais loggué (RBAC §8).
 *
 *  Rate-limit login : 5 tentatives / 5 min / IP (fenêtre glissante, mémoire
 *  locale — pas de Redis, mono-VPS). ARBITRAGE : TOUTES les tentatives
 *  comptent (succès inclus) — la 6ᵉ en fenêtre → 429, deterministic et plus
 *  strict qu'un comptage des seuls échecs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

export const INTERNAL_TOKEN_HEADER = "x-admin-internal";
export const SESSION_TOKEN_HEADER = "x-admin-session";
export const ACTOR_HEADER = "x-admin-actor";
export const CSRF_HEADER = "x-admin-csrf";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Comparaison timing-safe de deux chaînes (longueurs quelconques). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * Le token interne de la requête correspond-il au secret de l'env ?
 * Token absent de l'env → false TOUJOURS (fail-closed, y compris en dev).
 */
export function internalTokenOk(req: NextRequest): boolean {
  const expected = process.env.ADMIN_INTERNAL_TOKEN;
  if (!expected) return false;
  const got = req.headers.get(INTERNAL_TOKEN_HEADER);
  if (!got) return false;
  return safeEqual(expected, got);
}

/**
 * IP client pour le rate-limit login/break-glass — DERNIER saut de
 * x-forwarded-for (durcissement 2026-11, audit plateforme §4.4).
 *
 * Pourquoi le DERNIER et non le premier : la chaîne XFF est append-only et son
 * PREMIER maillon est contrôlé par le client (X-Forwarded-For: 1.2.3.4 forgé).
 * Chaque proxy de confiance (nginx-hôte, BFF admin) AJOUTE sa valeur EN FIN de
 * chaîne — le dernier maillon est donc la seule valeur que l'attaquant ne
 * contrôle pas. En production le BFF admin (composant interne de confiance)
 * transmet une valeur UNIQUE résolue par la logique durcie de
 * admin/src/lib/client-ip.ts (preuve Cloudflare), de sorte que le dernier
 * saut ici = l'IP réelle du visiteur.
 *
 * Dégradation sûre : sans XFF ni x-real-ip → "unknown" (bucket partagé,
 * plus restrictif — jamais plus permissif ; même arbitrage que client-ip.ts).
 */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

// ── Rate-limit auth (login / break-glass) : 5 tentatives / 5 min / IP ───────

const RATE_WINDOW_MS = 5 * 60_000;
const RATE_MAX_ATTEMPTS = 5;
/** IP → timestamps des tentatives de la fenêtre courante. */
const rateBuckets = new Map<string, number[]>();

/**
 * Consomme une tentative. Retourne false si la IP a déjà atteint la limite
 * (la requête 429 ne consomme RIEN — pas de prolongation infinie du blocage).
 */
export function loginRateCheck(ip: string, now = Date.now()): boolean {
  const key = ip || "unknown";
  const arr = (rateBuckets.get(key) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_ATTEMPTS) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  // hygiène mémoire : purge des clés entièrement expirées au-delà d'un plafond
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((ts) => now - ts >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return true;
}

/** Réinitialisation (tests uniquement). */
export function loginRateReset(ip?: string): void {
  if (ip) rateBuckets.delete(ip);
  else rateBuckets.clear();
}

/** Visibilité de la fenêtre courante (tests — combien de tentatives restantes). */
export function loginRateCount(ip: string, now = Date.now()): number {
  return (rateBuckets.get(ip || "unknown") ?? []).filter((ts) => now - ts < RATE_WINDOW_MS).length;
}
