/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  client-ip — IP client derrière Cloudflare (condition de sécurité n° 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Problème : `x-forwarded-for` (et tout en-tête proxy) peut être FORGÉ par le
 *  client. L'ancienne implémentation (`x-forwarded-for`.split(",")[0]) faisait
 *  confiance à la valeur contrôlée par l'attaquant → contournement du rate
 *  limiting par clé IP sur toutes les routes (posts, DMs, identity, likes,
 *  follows, bridge, seed).
 *
 *  Règle retenue :
 *   1. Cloudflare ajoute l'IP de son edge EN FIN de chaîne `x-forwarded-for`
 *      et ÉCRASE `cf-connecting-ip` avec l'IP réelle du visiteur. Une requête
 *      est donc « prouvée Cloudflare » si le DERNIER maillon de la chaîne XFF
 *      appartient aux plages officielles publiées par Cloudflare
 *      (https://www.cloudflare.com/ips/). Dans ce cas — et seulement dans ce
 *      cas — `cf-connecting-ip` est accepté comme IP client.
 *   2. Sans preuve de traversée CF, en PRODUCTION : retour `"local"` → toutes
 *      les requêtes non prouvées partagent un seul bucket de rate-limiting.
 *      Dégradation SÛRE : plus restrictif, jamais plus permissif. L'usurpation
 *      d'identité IP est impossible.
 *   3. Hors production (dev / sandbox derrière Caddy local) : comportement
 *      historique conservé pour les tests manuels locaux.
 *
 *  ⚠ Pré-requis de bout en bout : l'origine ne doit être joignable QUE via
 *  Cloudflare (nginx : allow <plages CF> / deny all — voir
 *  docs/RUNBOOK-NGINX-CF-LOCKDOWN.md). Tant que ce verrou n'est pas appliqué,
 *  une requête directe à l'origine avec en-têtes forgés peut simuler une
 *  traversée CF ; l'impact reste limité au bucket de rate-limiting usurpé
 *  (aucune élévation de privilège : la signature ECDSA reste obligatoire sur
 *  toutes les écritures).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Plages officielles publiées par Cloudflare (vérifiées 2025-11, source https://www.cloudflare.com/ips/). */
const CLOUDFLARE_IP_RANGES: readonly string[] = [
  // IPv4
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  // IPv6
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** Parse une IPv4 en entier non signé 32 bits, ou null si invalide. */
function ipv4ToUint32(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const oct = Number(m[i]);
    if (oct > 255) return null;
    out = out * 256 + oct;
  }
  return out >>> 0;
}

/** Parse une IPv6 en BigInt (forme complète ou abrégée `::`), ou null si invalide. */
function ipv6ToBigInt(ip: string): bigint | null {
  if (!ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!left || !right) return null;
  const fill = 8 - (left.length + right.length);
  if (fill < 0 || (halves.length === 1 && fill > 0)) return null;
  const groups = [...left, ...new Array<number>(Math.max(fill, 0)).fill(0), ...right];
  let out = 0n;
  for (const g of groups) out = (out << 16n) | BigInt(g);
  return out;
}

/** true si `ip` (valide) appartient au CIDR donné. IPv4 comparé à IPv4, IPv6 à IPv6. */
function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) return false;
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0) return false;
  const base = cidr.slice(0, slash);
  if (base.includes(":")) {
    if (bits > 128) return false;
    const a = ipv6ToBigInt(ip);
    const b = ipv6ToBigInt(base);
    if (a === null || b === null) return false;
    const mask = bits === 0 ? 0n : (((1n << BigInt(bits)) - 1n) << BigInt(128 - bits));
    return (a & mask) === (b & mask);
  }
  if (bits > 32) return false;
  const a = ipv4ToUint32(ip);
  const b = ipv4ToUint32(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((a ^ b) & mask) === 0;
}

/** true si l'IP est syntaxiquement valide (v4 ou v6) et appartient aux plages Cloudflare officielles. */
export function isCloudflareIp(ip: string): boolean {
  if (ip.includes(":")) {
    if (ipv6ToBigInt(ip) === null) return false;
  } else if (ipv4ToUint32(ip) === null) {
    return false;
  }
  return CLOUDFLARE_IP_RANGES.some((cidr) => ipInCidr(ip, cidr));
}

/** Dernier maillon d'une chaîne x-forwarded-for (ajouté par le proxy le plus proche du serveur). */
function lastXffHop(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (!fwd) return null;
  const hops = fwd
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return hops.length ? hops[hops.length - 1] : null;
}

/**
 * IP client pour le rate limiting (et tout usage de sécurité).
 * Voir l'en-tête du module pour la spécification complète.
 */
export function clientIp(headers: Headers): string {
  const cfc = (headers.get("cf-connecting-ip") ?? "").trim();
  const lastHop = lastXffHop(headers);

  // Preuve de traversée Cloudflare : dernier maillon XFF ∈ plages officielles
  // + présence de cf-ray (toujours posé par l'edge CF).
  if (cfc && lastHop && isCloudflareIp(lastHop) && headers.has("cf-ray")) {
    return cfc;
  }

  if (process.env.NODE_ENV !== "production") {
    // Dev / sandbox : comportement historique (Caddy local → x-forwarded-for).
    const fwd = headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    return headers.get("x-real-ip") ?? "local";
  }

  return "local";
}
