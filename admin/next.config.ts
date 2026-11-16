import type { NextConfig } from "next";

// ─────────────────────────────────────────────────────────────────────────────
// mbote-admin — en-têtes de sécurité durcis (panneau d'administration).
// Miroir de next.config.ts de l'app principale (F-35), resserré pour l'admin :
//  - CSP minimale : aucune source externe, frame-ancestors 'none' (anti-clicjack),
//  - 'unsafe-eval' en dev UNIQUEMENT (HMR Next) — jamais en production ;
//  - HSTS géré aussi par le vhost nginx (défense en profondeur).
// INVARIANT ARCHITECTURE (docs/specs/ADMIN-RBAC.md §1) : cette app ne touche
// JAMAIS la DB — pas de dépendance prisma ici, tout passe par HTTP interne.
// ─────────────────────────────────────────────────────────────────────────────

// Racine de projet ÉPINGLÉE : sans ça, Next 16 remonte au bun.lock parent
// (/home/z/my-project), infère la racine workspace et charge le
// src/instrumentation.ts de l'app PRINCIPALE (hub socket.io) dans l'app admin.
// const racineProjet = process.cwd() (scripts bun run exécutés depuis admin/)
const racineProjet = process.cwd();

const isDev = process.env.NODE_ENV !== "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: { root: racineProjet },
  outputFileTracingRoot: racineProjet,
  reactStrictMode: true,
  // Go-to-Market 2026-11 — obscurcissement de l'URL admin : le panneau peut
  // être servi sous un CHEMIN SECRET du domaine principal (ex. /console-xxxx/).
  // ADMIN_BASE_PATH est injecté par le compose depuis le .env VPS (et passé
  // aussi à NEXT_PUBLIC_ADMIN_BASE_PATH pour le client — cf. lib/api-base.ts).
  // Vide/absent = racine : comportement historique (dev, sous-domaine dédié).
  basePath: process.env.ADMIN_BASE_PATH || undefined,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
