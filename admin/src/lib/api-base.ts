// ─────────────────────────────────────────────────────────────────────────────
//  Base URL du panneau admin — support du déploiement sous CHEMIN SECRET.
//  (Go-to-Market 2026-11 : obscurcissement de l'URL admin — le panneau est
//  servi sous un chemin imprévisible du domaine principal, ex. /console-xxxx/,
//  via NEXT_PUBLIC_ADMIN_BASE_PATH à la BUILD time + ADMIN_BASE_PATH au
//  runtime pour le chemin du cookie. Vide = racine (dev sandbox, sous-domaine
//  dédié) — comportement historique inchangé.)
//
//  POURQUOI un wrapper et pas fetch() brut : les composants clients font des
//  fetch ABSOLUS (« /api/… »). Sous basePath Next.js, les routes/pages sont
//  préfixées automatiquement, mais un fetch absolu du navigateur ignore le
//  basePath et frapperait l'app principale. apiFetch préfixe en un seul
//  endroit — signature identique à fetch (drop-in).
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIN_API_BASE: string = process.env.NEXT_PUBLIC_ADMIN_BASE_PATH ?? "";

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ADMIN_API_BASE}${input}`, init);
}
