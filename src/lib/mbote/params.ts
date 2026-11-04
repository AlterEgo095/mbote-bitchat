/**
 * F-45 : validation uniforme des paramètres numériques de l'API.
 * `parseInt` nu renvoyait NaN (→ 500 Prisma) et laissait passer les négatifs.
 */

/** Retourne l'entier borné, ou null si absent/vide/invalide/hors bornes basses. */
export function parseBoundedInt(value: string | null, min: number, max: number): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < min) return null;
  return Math.min(n, max);
}

/** Précision géohash valide (1..12) depuis la querystring, ou null si invalide. */
export function parseGeohashPrecision(value: string | null): number | null {
  return parseBoundedInt(value, 1, 12);
}

/** Précision géohash depuis un corps JSON (nombre ou chaîne), ou null si invalide. */
export function parseBodyPrecision(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return n;
}
